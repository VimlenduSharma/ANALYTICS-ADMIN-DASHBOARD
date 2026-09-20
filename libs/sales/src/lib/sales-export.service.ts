import type { SalesExportJob } from '@analytics-admin/contracts';
import type { Environment } from '@analytics-admin/config';
import { DatabaseService } from '@analytics-admin/data-core';
import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import {
  salesExportStoredSchema,
  type SalesExportRequest,
} from './sales-filter';
import { SalesAnalyticsService } from './sales-analytics.service';

interface ExportRow {
  completedAt: Date | null;
  createdAt: Date;
  expiresAt: Date | null;
  failureCode: string | null;
  id: string;
  rowCount: number;
  status: SalesExportJob['status'];
}

interface ClaimedExport {
  attempts: number;
  filters: SalesExportRequest;
  id: string;
  organizationId: string;
  requestedByUserId: string;
}

@Injectable()
export class SalesExportService {
  private readonly logger = new Logger(SalesExportService.name);
  private readonly maxPending: number;
  private readonly maxRows: number;

  constructor(
    config: ConfigService<Environment, true>,
    private readonly analytics: SalesAnalyticsService,
    private readonly database: DatabaseService,
  ) {
    this.maxRows = config.getOrThrow('SALES_EXPORT_MAX_ROWS');
    this.maxPending = config.getOrThrow('QUEUE_MAX_PENDING_PER_ORG');
  }

  enqueue(input: {
    idempotencyKey: string;
    organizationId: string;
    request: SalesExportRequest;
    userId: string;
  }): Promise<SalesExportJob> {
    const requestSha256 = digest(input.request);
    return this.database.tenantTransaction(
      input.organizationId,
      async (client) => {
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [`sales-export:${input.organizationId}`],
        );
        let result = await client.query<ExportRow & { requestSha256: string }>(
          `${exportSelect}
         WHERE organization_id = $1
           AND requested_by_user_id = $2
           AND idempotency_key = $3`,
          [input.organizationId, input.userId, input.idempotencyKey],
        );
        let row = result.rows[0];
        if (!row) {
          await assertExportCapacity(
            client,
            input.organizationId,
            this.maxPending,
          );
          await client.query(
            `INSERT INTO sales_exports (
             organization_id, requested_by_user_id, idempotency_key,
             request_sha256, filters
           ) VALUES ($1, $2, $3, $4, $5)`,
            [
              input.organizationId,
              input.userId,
              input.idempotencyKey,
              requestSha256,
              input.request,
            ],
          );
          result = await client.query<ExportRow & { requestSha256: string }>(
            `${exportSelect}
             WHERE organization_id = $1
               AND requested_by_user_id = $2
               AND idempotency_key = $3`,
            [input.organizationId, input.userId, input.idempotencyKey],
          );
          row = required(result.rows[0], 'sales export');
        }
        if (row.requestSha256 !== requestSha256) {
          throw new ConflictException({
            code: 'IDEMPOTENCY_KEY_REUSED',
            message: 'The idempotency key was already used for another export',
          });
        }
        if (row.status === 'queued') {
          await client.query(
            `INSERT INTO sales_export_dispatch (organization_id)
             VALUES ($1)
             ON CONFLICT (organization_id) DO UPDATE SET
               available_at = least(sales_export_dispatch.available_at, now()),
               leased_until = NULL,
               updated_at = now()`,
            [input.organizationId],
          );
          await client.query(
            `INSERT INTO audit_events (
             organization_id, actor_user_id, event_type, target_type, target_id
           ) SELECT $1, $2, 'sales.export_requested', 'sales_export', $3
           WHERE NOT EXISTS (
             SELECT 1 FROM audit_events
             WHERE organization_id = $1 AND event_type = 'sales.export_requested'
               AND target_type = 'sales_export' AND target_id = $3
           )`,
            [input.organizationId, input.userId, row.id],
          );
        }
        return mapJob(row);
      },
    );
  }

  find(
    organizationId: string,
    exportId: string,
    userId: string,
  ): Promise<SalesExportJob | undefined> {
    return this.database.tenantReadTransaction(
      organizationId,
      async (client) => {
        const result = await client.query<ExportRow>(
          `${exportSelect}
         WHERE organization_id = $1 AND id = $2 AND requested_by_user_id = $3`,
          [organizationId, exportId, userId],
        );
        const row = result.rows[0];
        return row ? mapJob(row) : undefined;
      },
    );
  }

  download(
    organizationId: string,
    exportId: string,
    userId: string,
  ): Promise<{ csv: string; filename: string } | undefined> {
    return this.database.tenantReadTransaction(
      organizationId,
      async (client) => {
        const result = await client.query<{ csv: string }>(
          `SELECT csv_payload AS csv
         FROM sales_exports
         WHERE organization_id = $1 AND id = $2 AND requested_by_user_id = $3
           AND status = 'completed' AND expires_at > now()`,
          [organizationId, exportId, userId],
        );
        const row = result.rows[0];
        return row
          ? { csv: row.csv, filename: `sales-orders-${exportId}.csv` }
          : undefined;
      },
    );
  }

  async processNext(): Promise<boolean> {
    const organizationId = await this.leaseOrganization();
    if (!organizationId) return false;
    const job = await this.claim(organizationId);
    if (!job) {
      await this.releaseOrganization(organizationId);
      return true;
    }
    try {
      const result = await this.analytics.exportCsv(
        job.organizationId,
        job.filters,
        this.maxRows,
      );
      if (result.truncated) {
        await this.fail(job, 'EXPORT_ROW_LIMIT');
        return true;
      }
      await this.database.tenantTransaction(
        job.organizationId,
        async (client) => {
          await client.query(
            `UPDATE sales_exports SET
             status = 'completed', row_count = $3, csv_payload = $4,
             completed_at = now(), expires_at = now() + interval '24 hours',
             failure_code = NULL
           WHERE organization_id = $1 AND id = $2`,
            [job.organizationId, job.id, result.rowCount, result.csv],
          );
        },
      );
    } catch (error) {
      this.logger.error(
        `Sales export ${job.id} failed`,
        error instanceof Error ? error.stack : undefined,
      );
      await this.retryOrFail(job);
    } finally {
      await this.releaseOrganization(organizationId);
    }
    return true;
  }

  private leaseOrganization(): Promise<string | undefined> {
    return this.database.transaction(async (client) => {
      const result = await client.query<{ organizationId: string }>(
        `WITH candidate AS (
           SELECT organization_id
           FROM sales_export_dispatch
           WHERE available_at <= now()
             AND (leased_until IS NULL OR leased_until <= now())
           ORDER BY available_at, organization_id
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE sales_export_dispatch dispatch SET
           leased_until = now() + interval '5 minutes', updated_at = now()
         FROM candidate
         WHERE dispatch.organization_id = candidate.organization_id
         RETURNING dispatch.organization_id AS "organizationId"`,
      );
      return result.rows[0]?.organizationId;
    });
  }

  private claim(organizationId: string): Promise<ClaimedExport | undefined> {
    return this.database.tenantTransaction(organizationId, async (client) => {
      await client.query(
        `UPDATE sales_exports SET
           status = 'failed', failure_code = 'EXPORT_EXPIRED',
           csv_payload = NULL, completed_at = now(), expires_at = NULL
         WHERE organization_id = $1 AND status = 'completed'
           AND expires_at <= now()`,
        [organizationId],
      );
      await client.query(
        `UPDATE sales_exports SET status = 'queued', processing_started_at = NULL
         WHERE organization_id = $1 AND status = 'processing' AND attempts < 3
           AND processing_started_at < now() - interval '5 minutes'`,
        [organizationId],
      );
      await client.query(
        `UPDATE sales_exports SET
           status = 'failed', failure_code = 'EXPORT_RETRY_EXHAUSTED',
           completed_at = now(), processing_started_at = NULL
         WHERE organization_id = $1 AND status = 'processing' AND attempts >= 3
           AND processing_started_at < now() - interval '5 minutes'`,
        [organizationId],
      );
      const result = await client.query<ClaimedExport>(
        `WITH candidate AS (
           SELECT id FROM sales_exports
           WHERE organization_id = $1 AND status = 'queued'
           ORDER BY created_at, id
           FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE sales_exports job SET
           status = 'processing', attempts = attempts + 1,
           processing_started_at = now()
         FROM candidate
         WHERE job.id = candidate.id
         RETURNING job.id, job.organization_id AS "organizationId",
           job.requested_by_user_id AS "requestedByUserId",
           job.filters, job.attempts`,
        [organizationId],
      );
      const row = result.rows[0];
      return row
        ? { ...row, filters: salesExportStoredSchema.parse(row.filters) }
        : undefined;
    });
  }

  private releaseOrganization(organizationId: string): Promise<unknown> {
    return this.database.tenantTransaction(organizationId, async (client) => {
      const pending = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM sales_exports
           WHERE organization_id = $1 AND status IN ('queued', 'processing')
         ) AS exists`,
        [organizationId],
      );
      return pending.rows[0]?.exists
        ? client.query(
            `UPDATE sales_export_dispatch SET
               available_at = CASE
                 WHEN EXISTS (
                   SELECT 1 FROM sales_exports
                   WHERE organization_id = $1 AND status = 'queued'
                 ) THEN now()
                 ELSE now() + interval '5 minutes'
               END,
               leased_until = NULL, updated_at = now()
             WHERE organization_id = $1`,
            [organizationId],
          )
        : client.query(
            'DELETE FROM sales_export_dispatch WHERE organization_id = $1',
            [organizationId],
          );
    });
  }

  private fail(job: ClaimedExport, failureCode: string): Promise<unknown> {
    return this.database.tenantTransaction(job.organizationId, (client) =>
      client.query(
        `UPDATE sales_exports SET
           status = 'failed', failure_code = $3, csv_payload = NULL,
           completed_at = now(), processing_started_at = NULL
         WHERE organization_id = $1 AND id = $2`,
        [job.organizationId, job.id, failureCode],
      ),
    );
  }

  private retryOrFail(job: ClaimedExport): Promise<unknown> {
    if (job.attempts >= 3) return this.fail(job, 'EXPORT_RETRY_EXHAUSTED');
    return this.database.tenantTransaction(job.organizationId, (client) =>
      client.query(
        `UPDATE sales_exports SET status = 'queued', processing_started_at = NULL
         WHERE organization_id = $1 AND id = $2`,
        [job.organizationId, job.id],
      ),
    );
  }
}

async function assertExportCapacity(
  client: import('pg').PoolClient,
  organizationId: string,
  maxPending: number,
): Promise<void> {
  const result = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM sales_exports
     WHERE organization_id = $1 AND status IN ('queued', 'processing')`,
    [organizationId],
  );
  if ((result.rows[0]?.count ?? 0) < maxPending) return;
  throw new HttpException(
    {
      code: 'QUEUE_BACKPRESSURE',
      details: { limit: maxPending, queue: 'sales-export' },
      message: 'The organization export queue is at capacity',
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

const exportSelect = `SELECT id, status, row_count AS "rowCount",
  failure_code AS "failureCode", created_at AS "createdAt",
  completed_at AS "completedAt", expires_at AS "expiresAt",
  request_sha256 AS "requestSha256"
  FROM sales_exports`;

function mapJob(row: ExportRow): SalesExportJob {
  return compact({
    completedAt: row.completedAt?.toISOString(),
    createdAt: row.createdAt.toISOString(),
    downloadReady:
      row.status === 'completed' &&
      Boolean(row.expiresAt && row.expiresAt.getTime() > Date.now()),
    expiresAt: row.expiresAt?.toISOString(),
    failureCode: row.failureCode ?? undefined,
    id: row.id,
    rowCount: row.rowCount,
    status: row.status,
  });
}

function digest(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(',')}}`;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}

function required<T>(value: T | undefined, label: string): T {
  if (!value) throw new Error(`Missing ${label}`);
  return value;
}
