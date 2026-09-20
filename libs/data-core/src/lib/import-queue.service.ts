import type { Environment } from '@analytics-admin/config';
import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { parseOrderCsv, type ImportIssue } from './csv-orders';
import { DatabaseService } from './database.service';
import { DataCoreService } from './data-core.service';

export interface ImportJob {
  acceptedRows: number;
  createdAt: string;
  errorReport: ImportIssue[];
  filename: string;
  id: string;
  rejectedRows: number;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  totalRows: number;
}

interface ImportJobRow extends Omit<ImportJob, 'createdAt'> {
  createdAt: Date;
}

interface ClaimedImport {
  attempts: number;
  csvPayload: string;
  filename: string;
  id: string;
  organizationId: string;
  requestedByUserId: string;
}

@Injectable()
export class ImportQueueService {
  private readonly logger = new Logger(ImportQueueService.name);
  private readonly maxPending: number;
  private readonly maxRows: number;

  constructor(
    config: ConfigService<Environment, true>,
    private readonly database: DatabaseService,
    private readonly dataCore: DataCoreService,
  ) {
    this.maxRows = config.getOrThrow('IMPORT_MAX_ROWS');
    this.maxPending = config.getOrThrow('QUEUE_MAX_PENDING_PER_ORG');
  }

  enqueue(input: {
    csv: string;
    filename: string;
    idempotencyKey: string;
    organizationId: string;
    requestedByUserId: string;
  }): Promise<ImportJob> {
    const digest = createHash('sha256').update(input.csv).digest('hex');
    return this.database.tenantTransaction(
      input.organizationId,
      async (client) => {
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [`data-import:${input.organizationId}`],
        );
        let result = await client.query<
          ImportJobRow & { contentSha256: string }
        >(
          `
          SELECT
            id, filename, status, total_rows AS "totalRows",
            accepted_rows AS "acceptedRows", rejected_rows AS "rejectedRows",
            error_report AS "errorReport", created_at AS "createdAt",
            content_sha256 AS "contentSha256"
          FROM data_imports
          WHERE organization_id = $1 AND idempotency_key = $2
        `,
          [input.organizationId, input.idempotencyKey],
        );
        let job = result.rows[0];
        if (job) {
          if (job.contentSha256 !== digest) {
            throw new ConflictException({
              code: 'IDEMPOTENCY_KEY_REUSED',
              message:
                'The idempotency key was already used for a different file',
            });
          }
          return mapJob(job);
        }

        await assertQueueCapacity(
          client,
          input.organizationId,
          this.maxPending,
        );
        await client.query(
          `INSERT INTO data_imports (
            organization_id, requested_by_user_id, idempotency_key,
            filename, content_sha256, csv_payload
          ) VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            input.organizationId,
            input.requestedByUserId,
            input.idempotencyKey,
            input.filename,
            digest,
            input.csv,
          ],
        );
        result = await client.query<ImportJobRow & { contentSha256: string }>(
          `SELECT
            id, filename, status, total_rows AS "totalRows",
            accepted_rows AS "acceptedRows", rejected_rows AS "rejectedRows",
            error_report AS "errorReport", created_at AS "createdAt",
            content_sha256 AS "contentSha256"
          FROM data_imports
          WHERE organization_id = $1 AND idempotency_key = $2`,
          [input.organizationId, input.idempotencyKey],
        );
        job = result.rows[0];
        if (!job) throw new Error('Import job was not persisted');
        if (job.contentSha256 !== digest) {
          throw new ConflictException({
            code: 'IDEMPOTENCY_KEY_REUSED',
            message:
              'The idempotency key was already used for a different file',
          });
        }
        return mapJob(job);
      },
    );
  }

  async find(
    organizationId: string,
    importId: string,
  ): Promise<ImportJob | undefined> {
    return this.database.tenantTransaction(organizationId, async (client) => {
      const result = await client.query<ImportJobRow>(
        `
          SELECT
            id, filename, status, total_rows AS "totalRows",
            accepted_rows AS "acceptedRows", rejected_rows AS "rejectedRows",
            error_report AS "errorReport", created_at AS "createdAt"
          FROM data_imports
          WHERE organization_id = $1 AND id = $2
        `,
        [organizationId, importId],
      );
      const job = result.rows[0];
      return job ? mapJob(job) : undefined;
    });
  }

  async processNext(): Promise<boolean> {
    const job = await this.claim();
    if (!job) return false;

    const parsed = parseOrderCsv(job.csvPayload, this.maxRows);
    if (!parsed.ok) {
      await this.fail(job, parsed.issues, parsed.totalRows);
      return true;
    }

    try {
      await this.database.tenantTransaction(
        job.organizationId,
        async (client) => {
          for (const order of parsed.orders) {
            await this.dataCore.ingestOrderInTransaction(client, {
              actorUserId: job.requestedByUserId,
              idempotencyKey: `${job.id}:${order.externalId}`,
              order,
              organizationId: job.organizationId,
              source: `csv:${job.id}`,
            });
          }
          await client.query(
            `
            UPDATE data_imports
            SET
              status = 'completed', csv_payload = NULL, total_rows = $3,
              accepted_rows = $3, rejected_rows = 0, error_report = '[]'::jsonb,
              completed_at = now()
            WHERE organization_id = $1 AND id = $2
          `,
            [job.organizationId, job.id, parsed.totalRows],
          );
        },
      );
    } catch (error) {
      this.logger.error(
        `Import ${job.id} failed`,
        error instanceof Error ? error.stack : undefined,
      );
      await this.fail(
        job,
        [
          {
            field: 'file',
            message: 'The import could not be committed',
            row: 1,
          },
        ],
        parsed.totalRows,
      );
    }
    return true;
  }

  private claim(): Promise<ClaimedImport | undefined> {
    return this.database.transaction(async (client) => {
      await client.query(`
        UPDATE data_imports
        SET
          status = 'failed', csv_payload = NULL,
          accepted_rows = 0, rejected_rows = total_rows,
          error_report = jsonb_build_array(jsonb_build_object(
            'row', 1,
            'field', 'file',
            'message', 'The import stopped after repeated worker interruptions'
          )),
          processing_started_at = NULL, completed_at = now()
        WHERE
          status = 'processing'
          AND processing_started_at < now() - interval '5 minutes'
          AND attempts >= 5
      `);
      const result = await client.query<ClaimedImport>(
        `
          WITH candidate AS (
            SELECT id
            FROM data_imports
            WHERE
              status = 'queued'
              OR (
                status = 'processing'
                AND processing_started_at < now() - interval '5 minutes'
                AND attempts < 5
              )
            ORDER BY created_at, id
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          )
          UPDATE data_imports job
          SET
            status = 'processing', attempts = attempts + 1,
            processing_started_at = now()
          FROM candidate
          WHERE job.id = candidate.id
          RETURNING
            job.id, job.organization_id AS "organizationId",
            job.requested_by_user_id AS "requestedByUserId",
            job.filename, job.csv_payload AS "csvPayload", job.attempts
        `,
      );
      return result.rows[0];
    });
  }

  private fail(
    job: ClaimedImport,
    issues: ImportIssue[],
    totalRows: number,
  ): Promise<unknown> {
    return this.database.tenantTransaction(job.organizationId, (client) =>
      client.query(
        `
          UPDATE data_imports
          SET
            status = 'failed', csv_payload = NULL, total_rows = $3,
            accepted_rows = 0, rejected_rows = $3, error_report = $4,
            completed_at = now()
          WHERE organization_id = $1 AND id = $2
        `,
        [job.organizationId, job.id, totalRows, JSON.stringify(issues)],
      ),
    );
  }
}

async function assertQueueCapacity(
  client: import('pg').PoolClient,
  organizationId: string,
  maxPending: number,
): Promise<void> {
  const result = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM data_imports
     WHERE organization_id = $1 AND status IN ('queued', 'processing')`,
    [organizationId],
  );
  if ((result.rows[0]?.count ?? 0) < maxPending) return;
  throw new HttpException(
    {
      code: 'QUEUE_BACKPRESSURE',
      details: { limit: maxPending, queue: 'data-import' },
      message: 'The organization import queue is at capacity',
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

function mapJob(row: ImportJobRow): ImportJob {
  return { ...row, createdAt: row.createdAt.toISOString() };
}
