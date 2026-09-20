import type {
  GovernanceJob,
  GovernanceJobType,
} from '@analytics-admin/contracts';
import type { Environment } from '@analytics-admin/config';
import { DatabaseService } from '@analytics-admin/data-core';
import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PoolClient } from 'pg';
import {
  requestDigest,
  type GovernanceJobRequest,
  validateJobSubject,
} from './governance-filter';
import { CredentialCipher } from './credential-cipher';

interface JobRow extends Omit<
  GovernanceJob,
  'completedAt' | 'createdAt' | 'downloadReady' | 'expiresAt'
> {
  completedAt: Date | null;
  createdAt: Date;
  expiresAt: Date | null;
  requestSha256?: string;
}

interface ClaimedJob {
  attempts: number;
  id: string;
  organizationId: string;
  requestedByUserId: string;
  subjectExternalId?: string;
  type: GovernanceJobType;
}

interface RetentionPhase {
  deleteSql: string;
  name: string;
  setting:
    | 'auditRetentionDays'
    | 'exportRetentionHours'
    | 'operationalDataRetentionDays';
}

const retentionPhases: RetentionPhase[] = [
  {
    deleteSql: `DELETE FROM sales_exports WHERE id IN (
      SELECT id FROM sales_exports
      WHERE organization_id = $1 AND status IN ('completed', 'failed')
        AND created_at < now() - make_interval(hours => $2)
      ORDER BY created_at, id LIMIT 500
    )`,
    name: 'exports',
    setting: 'exportRetentionHours',
  },
  {
    deleteSql: `DELETE FROM data_imports WHERE id IN (
      SELECT id FROM data_imports
      WHERE organization_id = $1 AND status IN ('completed', 'failed')
        AND created_at < now() - make_interval(days => $2)
      ORDER BY created_at, id LIMIT 500
    )`,
    name: 'imports',
    setting: 'operationalDataRetentionDays',
  },
  {
    deleteSql: `DELETE FROM ingestion_requests WHERE id IN (
      SELECT id FROM ingestion_requests
      WHERE organization_id = $1 AND completed_at IS NOT NULL
        AND created_at < now() - make_interval(days => $2)
      ORDER BY created_at, id LIMIT 500
    )`,
    name: 'ingestion',
    setting: 'operationalDataRetentionDays',
  },
  {
    deleteSql: `DELETE FROM orders WHERE id IN (
      SELECT id FROM orders
      WHERE organization_id = $1
        AND status IN ('fulfilled', 'cancelled', 'refunded')
        AND occurred_at < now() - make_interval(days => $2)
      ORDER BY occurred_at, id LIMIT 500
    )`,
    name: 'orders',
    setting: 'operationalDataRetentionDays',
  },
  {
    deleteSql: `DELETE FROM audit_events WHERE id IN (
      SELECT id FROM audit_events
      WHERE organization_id = $1
        AND created_at < now() - make_interval(days => $2)
      ORDER BY created_at, id LIMIT 500
    )`,
    name: 'audit',
    setting: 'auditRetentionDays',
  },
];

@Injectable()
export class GovernanceJobsService {
  private readonly logger = new Logger(GovernanceJobsService.name);
  private readonly maxPending: number;

  constructor(
    config: ConfigService<Environment, true>,
    private readonly cipher: CredentialCipher,
    private readonly database: DatabaseService,
  ) {
    this.maxPending = config.getOrThrow('QUEUE_MAX_PENDING_PER_ORG');
  }

  enqueue(input: {
    idempotencyKey: string;
    organizationId: string;
    request: GovernanceJobRequest;
    userId: string;
  }): Promise<GovernanceJob> {
    try {
      validateJobSubject(input.request);
    } catch (error) {
      throw new ConflictException(
        error instanceof Error ? error.message : 'Invalid governance workflow',
      );
    }
    const digest = requestDigest(input.request);
    return this.withDatabaseErrors(() =>
      this.database.tenantTransaction(input.organizationId, async (client) => {
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [`governance-job:${input.organizationId}`],
        );
        let result = await client.query<JobRow>(
          `${jobSelect}
           WHERE job.organization_id = $1
             AND job.requested_by_user_id = $2
             AND job.idempotency_key = $3`,
          [input.organizationId, input.userId, input.idempotencyKey],
        );
        let row = result.rows[0];
        if (!row) {
          await assertGovernanceCapacity(
            client,
            input.organizationId,
            this.maxPending,
          );
          await client.query(
            `INSERT INTO governance_jobs (
               organization_id, type, requested_by_user_id, subject_external_id,
               idempotency_key, request_sha256
             ) VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              input.organizationId,
              input.request.type,
              input.userId,
              input.request.subjectExternalId ?? null,
              input.idempotencyKey,
              digest,
            ],
          );
          result = await client.query<JobRow>(
            `${jobSelect}
             WHERE job.organization_id = $1
               AND job.requested_by_user_id = $2
               AND job.idempotency_key = $3`,
            [input.organizationId, input.userId, input.idempotencyKey],
          );
          row = required(result.rows[0], 'governance job');
        }
        if (row.requestSha256 !== digest) {
          throw new ConflictException({
            code: 'IDEMPOTENCY_KEY_REUSED',
            message:
              'The idempotency key was already used for another workflow',
          });
        }
        await client.query(
          `INSERT INTO governance_job_dispatch (organization_id)
           VALUES ($1)
           ON CONFLICT (organization_id) DO UPDATE SET
             available_at = least(governance_job_dispatch.available_at, now()),
             leased_until = NULL, updated_at = now()`,
          [input.organizationId],
        );
        await client.query(
          `INSERT INTO audit_events (
             organization_id, actor_user_id, event_type, target_type, target_id,
             metadata
           ) SELECT $1, $2, 'governance.job_requested', 'governance_job', $3,
             jsonb_build_object('type', $4::text, 'subject', $5::text)
           WHERE NOT EXISTS (
             SELECT 1 FROM audit_events
             WHERE organization_id = $1
               AND event_type = 'governance.job_requested'
               AND target_type = 'governance_job' AND target_id = $3
           )`,
          [
            input.organizationId,
            input.userId,
            row.id,
            input.request.type,
            input.request.subjectExternalId ?? null,
          ],
        );
        return mapJob(row);
      }),
    );
  }

  find(
    organizationId: string,
    jobId: string,
  ): Promise<GovernanceJob | undefined> {
    return this.database.tenantReadTransaction(
      organizationId,
      async (client) => {
        const result = await client.query<JobRow>(
          `${jobSelect} WHERE job.organization_id = $1 AND job.id = $2`,
          [organizationId, jobId],
        );
        return result.rows[0] ? mapJob(result.rows[0]) : undefined;
      },
    );
  }

  download(
    organizationId: string,
    jobId: string,
  ): Promise<{ filename: string; payload: unknown } | undefined> {
    return this.database.tenantReadTransaction(
      organizationId,
      async (client) => {
        const job = await client.query<{
          subjectExternalId: string;
        }>(
          `SELECT subject_external_id AS "subjectExternalId"
         FROM governance_jobs
         WHERE organization_id = $1 AND id = $2
           AND type = 'privacy-export' AND status = 'completed'
           AND expires_at > now()`,
          [organizationId, jobId],
        );
        const subject = job.rows[0]?.subjectExternalId;
        if (!subject) return undefined;
        const chunks = await client.query<{
          authTag: Buffer;
          chunkIndex: number;
          ciphertext: Buffer;
          iv: Buffer;
        }>(
          `SELECT chunk_index AS "chunkIndex", ciphertext, iv,
           auth_tag AS "authTag"
         FROM governance_job_artifacts
         WHERE organization_id = $1 AND job_id = $2
         ORDER BY chunk_index`,
          [organizationId, jobId],
        );
        if (!chunks.rowCount) return undefined;
        const cleartext = Buffer.concat(
          chunks.rows.map((chunk) =>
            this.cipher.decrypt(
              chunk,
              `governance-artifact:${jobId}:${chunk.chunkIndex}`,
            ),
          ),
        );
        return {
          filename: `privacy-export-${safeFilename(subject)}.json`,
          payload: JSON.parse(cleartext.toString()) as unknown,
        };
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
      if (job.type === 'retention') await this.processRetention(job);
      else if (job.type === 'privacy-export') await this.processExport(job);
      else await this.processDeletion(job);
    } catch (error) {
      this.logger.error(
        `Governance job ${job.id} failed`,
        error instanceof Error ? error.stack : undefined,
      );
      await this.retryOrFail(job, error);
    } finally {
      await this.releaseOrganization(organizationId);
    }
    return true;
  }

  private leaseOrganization(): Promise<string | undefined> {
    return this.database.transaction(async (client) => {
      const result = await client.query<{ organizationId: string }>(
        `WITH candidate AS (
           SELECT organization_id FROM governance_job_dispatch
           WHERE available_at <= now()
             AND (leased_until IS NULL OR leased_until <= now())
           ORDER BY available_at, organization_id
           FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE governance_job_dispatch dispatch SET
           leased_until = now() + interval '5 minutes', updated_at = now()
         FROM candidate
         WHERE dispatch.organization_id = candidate.organization_id
         RETURNING dispatch.organization_id AS "organizationId"`,
      );
      return result.rows[0]?.organizationId;
    });
  }

  private claim(organizationId: string): Promise<ClaimedJob | undefined> {
    return this.database.tenantTransaction(organizationId, async (client) => {
      await client.query(
        `DELETE FROM governance_job_artifacts artifact
         USING governance_jobs job
         WHERE artifact.organization_id = $1
           AND artifact.job_id = job.id
           AND job.organization_id = $1 AND job.expires_at <= now()`,
        [organizationId],
      );
      await client.query(
        `UPDATE governance_jobs SET status = 'queued',
           processing_started_at = NULL, updated_at = now()
         WHERE organization_id = $1 AND status = 'processing' AND attempts < 5
           AND processing_started_at < now() - interval '5 minutes'`,
        [organizationId],
      );
      await client.query(
        `UPDATE governance_jobs SET status = 'failed',
           failure_code = 'GOVERNANCE_RETRY_EXHAUSTED', completed_at = now(),
           processing_started_at = NULL, updated_at = now()
         WHERE organization_id = $1 AND status = 'processing' AND attempts >= 5
           AND processing_started_at < now() - interval '5 minutes'`,
        [organizationId],
      );
      const result = await client.query<ClaimedJob>(
        `WITH candidate AS (
           SELECT id FROM governance_jobs
           WHERE organization_id = $1 AND status = 'queued'
           ORDER BY created_at, id
           FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE governance_jobs job SET status = 'processing',
           attempts = attempts + 1, processing_started_at = now(),
           updated_at = now()
         FROM candidate WHERE job.id = candidate.id
         RETURNING job.id, job.organization_id AS "organizationId",
           job.requested_by_user_id AS "requestedByUserId",
           job.subject_external_id AS "subjectExternalId", job.type,
           job.attempts`,
        [organizationId],
      );
      return result.rows[0];
    });
  }

  private async processRetention(job: ClaimedJob): Promise<void> {
    while (true) {
      const complete = await this.database.tenantTransaction(
        job.organizationId,
        async (client) => {
          const state = required(
            (
              await client.query<{
                auditRetentionDays: number;
                exportRetentionHours: number;
                operationalDataRetentionDays: number;
                phase: number;
              }>(
                `SELECT COALESCE((job.checkpoint->>'phase')::integer, 0) AS phase,
                   COALESCE(settings.operational_data_retention_days, 730)
                     AS "operationalDataRetentionDays",
                   COALESCE(settings.audit_retention_days, 730)
                     AS "auditRetentionDays",
                   COALESCE(settings.export_retention_hours, 24)
                     AS "exportRetentionHours"
                 FROM governance_jobs job
                 LEFT JOIN organization_governance_settings settings
                   ON settings.organization_id = job.organization_id
                 WHERE job.organization_id = $1 AND job.id = $2
                 FOR UPDATE OF job`,
                [job.organizationId, job.id],
              )
            ).rows[0],
            'retention job',
          );
          const phase = retentionPhases[state.phase];
          if (!phase) {
            await completeJob(client, job, 'governance.retention_completed');
            return true;
          }
          const deleted = await client.query(phase.deleteSql, [
            job.organizationId,
            state[phase.setting],
          ]);
          await client.query(
            `UPDATE governance_jobs SET
               checkpoint = jsonb_build_object('phase', $3::integer, 'name', $4::text),
               processed_count = processed_count + $5, updated_at = now()
             WHERE organization_id = $1 AND id = $2`,
            [
              job.organizationId,
              job.id,
              deleted.rowCount ? state.phase : state.phase + 1,
              phase.name,
              deleted.rowCount ?? 0,
            ],
          );
          return false;
        },
      );
      if (complete) return;
    }
  }

  private processExport(job: ClaimedJob): Promise<void> {
    return this.database.tenantTransaction(
      job.organizationId,
      async (client) => {
        const result = await client.query<{ payload: unknown }>(
          `SELECT jsonb_build_object(
           'generatedAt', now(),
           'customer', jsonb_build_object(
             'externalId', customer.external_id,
             'countryCode', customer.country_code,
             'metadata', customer.metadata,
             'createdAt', customer.created_at,
             'updatedAt', customer.updated_at
           ),
           'orders', COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
               'externalId', orders.external_id,
               'orderNumber', orders.order_number,
               'status', orders.status,
               'currency', orders.currency,
               'totalMinor', orders.total_minor,
               'occurredAt', orders.occurred_at,
               'metadata', orders.metadata,
               'items', COALESCE((
                 SELECT jsonb_agg(jsonb_build_object(
                   'externalId', item.external_id, 'sku', item.sku,
                   'name', item.name, 'quantity', item.quantity,
                   'totalMinor', item.total_minor
                 ) ORDER BY item.id)
                 FROM order_items item
                 WHERE item.organization_id = orders.organization_id
                   AND item.order_id = orders.id
               ), '[]'::jsonb)
             ) ORDER BY orders.occurred_at, orders.id)
             FROM orders
             WHERE orders.organization_id = customer.organization_id
               AND orders.customer_reference_id = customer.id
           ), '[]'::jsonb)
         ) AS payload
         FROM customer_references customer
         WHERE customer.organization_id = $1 AND customer.external_id = $2`,
          [job.organizationId, job.subjectExternalId],
        );
        const payload = result.rows[0]?.payload;
        if (!payload) throw new TerminalJobError('CUSTOMER_NOT_FOUND');
        const cleartext = Buffer.from(JSON.stringify(payload));
        await client.query(
          `DELETE FROM governance_job_artifacts
         WHERE organization_id = $1 AND job_id = $2`,
          [job.organizationId, job.id],
        );
        for (
          let offset = 0, chunkIndex = 0;
          offset < cleartext.length;
          offset += 65_536
        ) {
          const encrypted = this.cipher.encrypt(
            cleartext.subarray(offset, offset + 65_536),
            `governance-artifact:${job.id}:${chunkIndex}`,
          );
          await client.query(
            `INSERT INTO governance_job_artifacts (
             job_id, organization_id, chunk_index, ciphertext, iv, auth_tag
           ) VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              job.id,
              job.organizationId,
              chunkIndex,
              encrypted.ciphertext,
              encrypted.iv,
              encrypted.authTag,
            ],
          );
          chunkIndex += 1;
        }
        const expiry = await privacyExportHours(client, job.organizationId);
        await client.query(
          `UPDATE governance_jobs SET status = 'completed', completed_at = now(),
           expires_at = now() + make_interval(hours => $3),
           processed_count = 1, processing_started_at = NULL, updated_at = now()
         WHERE organization_id = $1 AND id = $2`,
          [job.organizationId, job.id, expiry],
        );
        await jobAudit(client, job, 'governance.privacy_export_completed');
      },
    );
  }

  private async processDeletion(job: ClaimedJob): Promise<void> {
    while (true) {
      const complete = await this.database.tenantTransaction(
        job.organizationId,
        async (client) => {
          const customer = await client.query<{ id: string }>(
            `SELECT id FROM customer_references
             WHERE organization_id = $1 AND external_id = $2 FOR UPDATE`,
            [job.organizationId, job.subjectExternalId],
          );
          const customerId = customer.rows[0]?.id;
          if (!customerId) {
            const processed = await client.query<{ processedCount: string }>(
              `SELECT processed_count::text AS "processedCount"
               FROM governance_jobs WHERE organization_id = $1 AND id = $2`,
              [job.organizationId, job.id],
            );
            if (Number(processed.rows[0]?.processedCount ?? 0) === 0) {
              throw new TerminalJobError('CUSTOMER_NOT_FOUND');
            }
            await completeJob(
              client,
              job,
              'governance.privacy_deletion_completed',
            );
            return true;
          }
          const detached = await client.query(
            `UPDATE orders SET customer_reference_id = NULL,
               metadata = '{}'::jsonb, updated_at = now()
             WHERE id IN (
               SELECT id FROM orders
               WHERE organization_id = $1 AND customer_reference_id = $2
               ORDER BY id LIMIT 500
             )`,
            [job.organizationId, customerId],
          );
          if (detached.rowCount) {
            await client.query(
              `UPDATE governance_jobs SET
                 processed_count = processed_count + $3,
                 checkpoint = jsonb_build_object('phase', 'orders'),
                 updated_at = now()
               WHERE organization_id = $1 AND id = $2`,
              [job.organizationId, job.id, detached.rowCount],
            );
            return false;
          }
          await client.query(
            `DELETE FROM customer_references
             WHERE organization_id = $1 AND id = $2`,
            [job.organizationId, customerId],
          );
          await client.query(
            `UPDATE governance_jobs SET processed_count = processed_count + 1
             WHERE organization_id = $1 AND id = $2`,
            [job.organizationId, job.id],
          );
          await completeJob(
            client,
            job,
            'governance.privacy_deletion_completed',
          );
          return true;
        },
      );
      if (complete) return;
    }
  }

  private retryOrFail(job: ClaimedJob, error: unknown): Promise<unknown> {
    if (error instanceof TerminalJobError) return this.fail(job, error.code);
    if (job.attempts >= 5) {
      return this.fail(job, 'GOVERNANCE_RETRY_EXHAUSTED');
    }
    return this.database.tenantTransaction(job.organizationId, (client) =>
      client.query(
        `UPDATE governance_jobs SET status = 'queued',
           processing_started_at = NULL, updated_at = now()
         WHERE organization_id = $1 AND id = $2`,
        [job.organizationId, job.id],
      ),
    );
  }

  private fail(job: ClaimedJob, code: string): Promise<unknown> {
    return this.database.tenantTransaction(
      job.organizationId,
      async (client) => {
        await client.query(
          `UPDATE governance_jobs SET status = 'failed', failure_code = $3,
           completed_at = now(), processing_started_at = NULL, updated_at = now()
         WHERE organization_id = $1 AND id = $2`,
          [job.organizationId, job.id, code],
        );
        await jobAudit(client, job, 'governance.job_failed', { code });
      },
    );
  }

  private releaseOrganization(organizationId: string): Promise<unknown> {
    return this.database.tenantTransaction(organizationId, async (client) => {
      const pending = await client.query<{ queued: boolean; running: boolean }>(
        `SELECT
           EXISTS (SELECT 1 FROM governance_jobs
             WHERE organization_id = $1 AND status = 'queued') AS queued,
           EXISTS (SELECT 1 FROM governance_jobs
             WHERE organization_id = $1 AND status = 'processing') AS running`,
        [organizationId],
      );
      const state = pending.rows[0];
      if (!state?.queued && !state?.running) {
        return client.query(
          'DELETE FROM governance_job_dispatch WHERE organization_id = $1',
          [organizationId],
        );
      }
      return client.query(
        `UPDATE governance_job_dispatch SET available_at = $2,
           leased_until = NULL, updated_at = now()
         WHERE organization_id = $1`,
        [
          organizationId,
          state.queued ? new Date() : new Date(Date.now() + 300_000),
        ],
      );
    });
  }

  private withDatabaseErrors<T>(work: () => Promise<T>): Promise<T> {
    return work().catch((error: unknown) => {
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          'A matching privacy workflow is already active',
        );
      }
      throw error;
    });
  }
}

async function assertGovernanceCapacity(
  client: PoolClient,
  organizationId: string,
  maxPending: number,
): Promise<void> {
  const result = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM governance_jobs
     WHERE organization_id = $1 AND status IN ('queued', 'processing')`,
    [organizationId],
  );
  if ((result.rows[0]?.count ?? 0) < maxPending) return;
  throw new HttpException(
    {
      code: 'QUEUE_BACKPRESSURE',
      details: { limit: maxPending, queue: 'governance-job' },
      message: 'The organization governance queue is at capacity',
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

const jobSelect = `SELECT job.id, job.type, job.status,
  job.subject_external_id AS "subjectExternalId",
  job.processed_count::integer AS "processedCount",
  job.failure_code AS "failureCode", job.created_at AS "createdAt",
  job.completed_at AS "completedAt", job.expires_at AS "expiresAt",
  job.request_sha256 AS "requestSha256",
  person.display_name AS "requestedByDisplayName"
  FROM governance_jobs job
  JOIN identity_users person ON person.id = job.requested_by_user_id`;

function mapJob(row: JobRow): GovernanceJob {
  return {
    completedAt: iso(row.completedAt),
    createdAt: row.createdAt.toISOString(),
    downloadReady:
      row.type === 'privacy-export' &&
      row.status === 'completed' &&
      Boolean(row.expiresAt && row.expiresAt > new Date()),
    expiresAt: iso(row.expiresAt),
    failureCode: row.failureCode,
    id: row.id,
    processedCount: row.processedCount,
    requestedByDisplayName: row.requestedByDisplayName,
    status: row.status,
    subjectExternalId: row.subjectExternalId,
    type: row.type,
  };
}

async function completeJob(
  client: PoolClient,
  job: ClaimedJob,
  eventType: string,
): Promise<void> {
  await client.query(
    `UPDATE governance_jobs SET status = 'completed', completed_at = now(),
       processing_started_at = NULL, updated_at = now()
     WHERE organization_id = $1 AND id = $2`,
    [job.organizationId, job.id],
  );
  await jobAudit(client, job, eventType);
}

async function jobAudit(
  client: PoolClient,
  job: ClaimedJob,
  eventType: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events (
       organization_id, actor_user_id, event_type, target_type, target_id, metadata
     ) VALUES ($1, $2, $3, 'governance_job', $4, $5)`,
    [job.organizationId, job.requestedByUserId, eventType, job.id, metadata],
  );
}

async function privacyExportHours(
  client: PoolClient,
  organizationId: string,
): Promise<number> {
  const result = await client.query<{ hours: number }>(
    `SELECT COALESCE(privacy_export_retention_hours, 24) AS hours
     FROM organization_governance_settings WHERE organization_id = $1`,
    [organizationId],
  );
  return result.rows[0]?.hours ?? 24;
}

function safeFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80) || 'customer';
}

function iso(value: Date | null | undefined): string | undefined {
  return value?.toISOString();
}

function required<T>(value: T | undefined, label: string): T {
  if (!value) throw new NotFoundException(`${label} not found`);
  return value;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505'
  );
}

class TerminalJobError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
