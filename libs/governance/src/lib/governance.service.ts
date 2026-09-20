import type {
  CreatedOrganizationInvitation,
  GovernanceAuditResponse,
  GovernanceDataSource,
  GovernanceJob,
  GovernanceOverview,
  OrganizationAccess,
  OrganizationGovernanceSettings,
  OrganizationInvitation,
  OrganizationRole,
  UserProfile,
} from '@analytics-admin/contracts';
import { DatabaseService } from '@analytics-admin/data-core';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type {
  GovernanceAuditQuery,
  GovernanceSettingsInput,
} from './governance-filter';

interface InvitationRow extends Omit<
  OrganizationInvitation,
  'acceptedAt' | 'createdAt' | 'expiresAt'
> {
  acceptedAt: Date | null;
  createdAt: Date;
  expiresAt: Date;
}

interface AuditRow {
  actorDisplayName: string | null;
  createdAt: Date;
  eventType: string;
  id: string;
  metadata: Record<string, unknown>;
  targetId: string | null;
  targetType: string | null;
}

interface AuditCursor {
  createdAt: string;
  filterHash: string;
  id: string;
}

interface SettingsRow {
  auditRetentionDays: number;
  exportRetentionHours: number;
  operationalDataRetentionDays: number;
  privacyExportRetentionHours: number;
  reportingTimezone: string;
  updatedAt: Date | null;
  weekStartsOn: number;
}

interface JobRow extends Omit<
  GovernanceJob,
  'completedAt' | 'createdAt' | 'downloadReady' | 'expiresAt'
> {
  completedAt: Date | null;
  createdAt: Date;
  expiresAt: Date | null;
}

const cursorSchema = z.strictObject({
  createdAt: z.iso.datetime({ offset: true }),
  filterHash: z.string().length(64),
  id: z.string().regex(/^\d+$/),
});

@Injectable()
export class GovernanceService {
  constructor(private readonly database: DatabaseService) {}

  async profile(userId: string): Promise<UserProfile> {
    const result = await this.database.query<UserProfile>(
      `SELECT display_name AS "displayName", email, locale, timezone
       FROM identity_users WHERE id = $1`,
      [userId],
    );
    return required(result.rows[0], 'profile');
  }

  updateProfile(
    userId: string,
    input: Pick<UserProfile, 'displayName' | 'locale' | 'timezone'>,
  ): Promise<UserProfile> {
    return this.database.transaction(async (client) => {
      const result = await client.query<UserProfile>(
        `UPDATE identity_users
         SET display_name = $2, locale = $3, timezone = $4, updated_at = now()
         WHERE id = $1
         RETURNING display_name AS "displayName", email, locale, timezone`,
        [userId, input.displayName, input.locale, input.timezone],
      );
      await audit(client, {
        actorUserId: userId,
        eventType: 'profile.updated',
        targetId: userId,
        targetType: 'user',
        metadata: { locale: input.locale, timezone: input.timezone },
      });
      return required(result.rows[0], 'profile');
    });
  }

  overview(organizationId: string): Promise<GovernanceOverview> {
    return this.database.tenantTransaction(organizationId, async (client) => {
      await expireInvitations(client, organizationId);
      const settings = await this.settingsInTransaction(client, organizationId);
      const invitations = await this.invitationsInTransaction(
        client,
        organizationId,
      );
      const sources = await this.sourcesInTransaction(client, organizationId);
      const jobs = await this.jobsInTransaction(client, organizationId);
      return { invitations, jobs, settings, sources };
    });
  }

  settings(organizationId: string): Promise<OrganizationGovernanceSettings> {
    return this.database.tenantReadTransaction(organizationId, (client) =>
      this.settingsInTransaction(client, organizationId),
    );
  }

  updateSettings(
    actorUserId: string,
    organizationId: string,
    input: GovernanceSettingsInput,
  ): Promise<OrganizationGovernanceSettings> {
    return this.database.tenantTransaction(organizationId, async (client) => {
      await client.query(
        `UPDATE organizations SET name = $2, updated_at = now() WHERE id = $1`,
        [organizationId, input.name],
      );
      const result = await client.query<SettingsRow>(
        `INSERT INTO organization_governance_settings (
           organization_id, reporting_timezone, week_starts_on,
           operational_data_retention_days, audit_retention_days,
           export_retention_hours, privacy_export_retention_hours,
           updated_by_user_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (organization_id) DO UPDATE SET
           reporting_timezone = EXCLUDED.reporting_timezone,
           week_starts_on = EXCLUDED.week_starts_on,
           operational_data_retention_days = EXCLUDED.operational_data_retention_days,
           audit_retention_days = EXCLUDED.audit_retention_days,
           export_retention_hours = EXCLUDED.export_retention_hours,
           privacy_export_retention_hours = EXCLUDED.privacy_export_retention_hours,
           updated_by_user_id = EXCLUDED.updated_by_user_id,
           updated_at = now()
         RETURNING
           reporting_timezone AS "reportingTimezone",
           week_starts_on AS "weekStartsOn",
           operational_data_retention_days AS "operationalDataRetentionDays",
           audit_retention_days AS "auditRetentionDays",
           export_retention_hours AS "exportRetentionHours",
           privacy_export_retention_hours AS "privacyExportRetentionHours",
           updated_at AS "updatedAt"`,
        [
          organizationId,
          input.reportingTimezone,
          input.weekStartsOn,
          input.operationalDataRetentionDays,
          input.auditRetentionDays,
          input.exportRetentionHours,
          input.privacyExportRetentionHours,
          actorUserId,
        ],
      );
      await audit(client, {
        actorUserId,
        eventType: 'governance.settings_updated',
        organizationId,
        targetId: organizationId,
        targetType: 'organization',
        metadata: {
          auditRetentionDays: input.auditRetentionDays,
          operationalDataRetentionDays: input.operationalDataRetentionDays,
          reportingTimezone: input.reportingTimezone,
        },
      });
      return mapSettings(required(result.rows[0], 'governance settings'), {
        name: input.name,
        slug: await organizationSlug(client, organizationId),
      });
    });
  }

  invitations(organizationId: string): Promise<OrganizationInvitation[]> {
    return this.database.tenantTransaction(organizationId, async (client) => {
      await expireInvitations(client, organizationId);
      return this.invitationsInTransaction(client, organizationId);
    });
  }

  createInvitation(input: {
    actorRole: OrganizationRole;
    actorUserId: string;
    email: string;
    organizationId: string;
    role: Exclude<OrganizationRole, 'OWNER'>;
  }): Promise<CreatedOrganizationInvitation> {
    if (!canInvite(input.actorRole, input.role)) {
      throw new ForbiddenException('The requested role cannot be assigned');
    }
    const token = randomBytes(32).toString('base64url');
    return this.databaseError(() =>
      this.database.tenantTransaction(input.organizationId, async (client) => {
        const member = await client.query(
          `SELECT 1 FROM organization_memberships membership
           JOIN identity_users person ON person.id = membership.user_id
           WHERE membership.organization_id = $1
             AND person.email_normalized = lower($2)`,
          [input.organizationId, input.email],
        );
        if (member.rowCount) {
          throw new ConflictException('This person is already a member');
        }
        await expireInvitations(client, input.organizationId);
        const result = await client.query<InvitationRow>(
          `INSERT INTO organization_invitations (
             organization_id, email, role, token_sha256,
             created_by_user_id, expires_at
           ) VALUES ($1, $2, $3, $4, $5, now() + interval '7 days')
           RETURNING id, email, role, status, expires_at AS "expiresAt",
             accepted_at AS "acceptedAt", created_at AS "createdAt"`,
          [
            input.organizationId,
            input.email,
            input.role,
            sha256(token),
            input.actorUserId,
          ],
        );
        const invitation = mapInvitation(
          required(result.rows[0], 'invitation'),
        );
        await audit(client, {
          actorUserId: input.actorUserId,
          eventType: 'membership.invitation_created',
          organizationId: input.organizationId,
          targetId: invitation.id,
          targetType: 'invitation',
          metadata: { email: input.email, role: input.role },
        });
        return {
          ...invitation,
          acceptancePath: `/organizations/${input.organizationId}/accept-invitation#token=${token}`,
        };
      }),
    );
  }

  revokeInvitation(
    actorUserId: string,
    organizationId: string,
    invitationId: string,
  ): Promise<void> {
    return this.database.tenantTransaction(organizationId, async (client) => {
      const result = await client.query(
        `UPDATE organization_invitations
         SET status = 'revoked', revoked_by_user_id = $3,
           revoked_at = now(), updated_at = now()
         WHERE organization_id = $1 AND id = $2 AND status = 'pending'`,
        [organizationId, invitationId, actorUserId],
      );
      if (!result.rowCount) {
        throw new NotFoundException('Pending invitation not found');
      }
      await audit(client, {
        actorUserId,
        eventType: 'membership.invitation_revoked',
        organizationId,
        targetId: invitationId,
        targetType: 'invitation',
      });
    });
  }

  acceptInvitation(input: {
    organizationId: string;
    token: string;
    userId: string;
  }): Promise<OrganizationAccess> {
    return this.database.tenantTransaction(
      input.organizationId,
      async (client) => {
        const result = await client.query<
          InvitationRow & { acceptedByUserId: string | null }
        >(
          `SELECT id, email, role, status, expires_at AS "expiresAt",
           accepted_at AS "acceptedAt", created_at AS "createdAt",
           accepted_by_user_id AS "acceptedByUserId"
         FROM organization_invitations
         WHERE organization_id = $1 AND token_sha256 = $2
         FOR UPDATE`,
          [input.organizationId, sha256(input.token)],
        );
        const invitation = required(result.rows[0], 'invitation');
        const person = required(
          (
            await client.query<{ email: string }>(
              'SELECT email FROM identity_users WHERE id = $1',
              [input.userId],
            )
          ).rows[0],
          'user',
        );
        if (person.email.toLowerCase() !== invitation.email.toLowerCase()) {
          throw new ForbiddenException(
            'This invitation belongs to another email address',
          );
        }
        if (
          invitation.status === 'accepted' &&
          invitation.acceptedByUserId === input.userId
        ) {
          return organizationAccess(
            client,
            input.organizationId,
            invitation.role,
          );
        }
        if (
          invitation.status !== 'pending' ||
          invitation.expiresAt <= new Date()
        ) {
          throw new ConflictException('This invitation is no longer active');
        }
        await client.query(
          `INSERT INTO organization_memberships (
           organization_id, user_id, role, created_by_user_id
         ) VALUES ($1, $2, $3, $2)
         ON CONFLICT (organization_id, user_id) DO NOTHING`,
          [input.organizationId, input.userId, invitation.role],
        );
        await client.query(
          `UPDATE organization_invitations
         SET status = 'accepted', accepted_by_user_id = $3,
           accepted_at = now(), updated_at = now()
         WHERE organization_id = $1 AND id = $2`,
          [input.organizationId, invitation.id, input.userId],
        );
        await audit(client, {
          actorUserId: input.userId,
          eventType: 'membership.invitation_accepted',
          organizationId: input.organizationId,
          targetId: input.userId,
          targetType: 'user',
          metadata: { invitationId: invitation.id, role: invitation.role },
        });
        return organizationAccess(
          client,
          input.organizationId,
          invitation.role,
        );
      },
    );
  }

  auditEvents(
    organizationId: string,
    query: GovernanceAuditQuery,
  ): Promise<GovernanceAuditResponse> {
    return this.database.tenantReadTransaction(
      organizationId,
      async (client) => {
        const filterHash = sha256(
          JSON.stringify([
            query.actorUserId ?? null,
            query.eventType ?? null,
            query.from ?? null,
            query.to ?? null,
          ]),
        );
        const cursor = decodeCursor(query.cursor, filterHash);
        const values: unknown[] = [organizationId];
        const where = ['event.organization_id = $1'];
        addFilter(where, values, 'event.actor_user_id =', query.actorUserId);
        addFilter(where, values, 'event.event_type =', query.eventType);
        addFilter(where, values, 'event.created_at >=', query.from);
        addFilter(where, values, 'event.created_at <=', query.to);
        if (cursor) {
          values.push(cursor.createdAt, cursor.id);
          where.push(
            `(event.created_at, event.id) < ($${values.length - 1}::timestamptz, $${values.length}::bigint)`,
          );
        }
        values.push(query.pageSize + 1);
        const result = await client.query<AuditRow>(
          `SELECT event.id::text, event.event_type AS "eventType",
           event.target_type AS "targetType", event.target_id AS "targetId",
           event.metadata, event.created_at AS "createdAt",
           actor.display_name AS "actorDisplayName"
         FROM audit_events event
         LEFT JOIN identity_users actor ON actor.id = event.actor_user_id
         WHERE ${where.join(' AND ')}
         ORDER BY event.created_at DESC, event.id DESC
         LIMIT $${values.length}`,
          values,
        );
        const hasNextPage = result.rows.length > query.pageSize;
        const rows = result.rows.slice(0, query.pageSize);
        const last = rows.at(-1);
        return {
          filters: {
            actorUserId: query.actorUserId,
            eventType: query.eventType,
            from: query.from,
            to: query.to,
          },
          items: rows.map((row) => ({
            actorDisplayName: row.actorDisplayName ?? undefined,
            createdAt: row.createdAt.toISOString(),
            eventType: row.eventType,
            id: row.id,
            metadata: row.metadata,
            targetId: row.targetId ?? undefined,
            targetType: row.targetType ?? undefined,
          })),
          pageInfo: {
            hasNextPage,
            nextCursor:
              hasNextPage && last ? encodeCursor(last, filterHash) : undefined,
            pageSize: query.pageSize,
          },
        };
      },
    );
  }

  private async settingsInTransaction(
    client: PoolClient,
    organizationId: string,
  ): Promise<OrganizationGovernanceSettings> {
    const result = await client.query<
      SettingsRow & { name: string; slug: string }
    >(
      `SELECT organization.name, organization.slug,
         COALESCE(settings.reporting_timezone, 'UTC') AS "reportingTimezone",
         COALESCE(settings.week_starts_on, 1) AS "weekStartsOn",
         COALESCE(settings.operational_data_retention_days, 730)
           AS "operationalDataRetentionDays",
         COALESCE(settings.audit_retention_days, 730) AS "auditRetentionDays",
         COALESCE(settings.export_retention_hours, 24) AS "exportRetentionHours",
         COALESCE(settings.privacy_export_retention_hours, 24)
           AS "privacyExportRetentionHours",
         settings.updated_at AS "updatedAt"
       FROM organizations organization
       LEFT JOIN organization_governance_settings settings
         ON settings.organization_id = organization.id
       WHERE organization.id = $1`,
      [organizationId],
    );
    const row = required(result.rows[0], 'organization settings');
    return mapSettings(row, row);
  }

  private async invitationsInTransaction(
    client: PoolClient,
    organizationId: string,
  ): Promise<OrganizationInvitation[]> {
    const result = await client.query<InvitationRow>(
      `SELECT id, email, role, status, expires_at AS "expiresAt",
         accepted_at AS "acceptedAt", created_at AS "createdAt"
       FROM organization_invitations
       WHERE organization_id = $1
       ORDER BY created_at DESC, id DESC LIMIT 100`,
      [organizationId],
    );
    return result.rows.map(mapInvitation);
  }

  private async sourcesInTransaction(
    client: PoolClient,
    organizationId: string,
  ): Promise<GovernanceDataSource[]> {
    const activity = await client.query<{
      eventCount: string;
      lastReceivedAt: Date | null;
      source: string;
    }>(
      `SELECT source, count(*)::text AS "eventCount",
         max(completed_at) AS "lastReceivedAt"
       FROM ingestion_requests
       WHERE organization_id = $1
       GROUP BY source`,
      [organizationId],
    );
    const activityBySource = new Map(
      activity.rows.map((row) => [row.source, row]),
    );
    const imports = await client.query<{
      eventCount: string;
      lastReceivedAt: Date | null;
    }>(
      `SELECT count(*)::text AS "eventCount", max(completed_at) AS "lastReceivedAt"
       FROM data_imports WHERE organization_id = $1 AND status = 'completed'`,
      [organizationId],
    );
    const webhooks = await client.query<{
      credentialRotatedAt: Date | null;
      id: string;
      lastReceivedAt: Date | null;
      name: string;
      status: 'active' | 'revoked';
    }>(
      `SELECT id, name, status, credential_rotated_at AS "credentialRotatedAt",
         last_received_at AS "lastReceivedAt"
       FROM webhook_endpoints
       WHERE organization_id = $1
       ORDER BY created_at DESC, id DESC`,
      [organizationId],
    );
    return [
      mapFixedSource(
        'orders-api',
        'Orders REST API',
        activityBySource.get('rest:orders'),
      ),
      mapFixedSource(
        'inventory-api',
        'Inventory REST API',
        activityBySource.get('rest:inventory'),
      ),
      mapFixedSource('csv', 'CSV order imports', imports.rows[0]),
      ...webhooks.rows.map((source) => {
        const webhookActivity = activityBySource.get(`webhook:${source.id}`);
        return {
          credentialRotatedAt: iso(source.credentialRotatedAt),
          eventCount: Number(webhookActivity?.eventCount ?? 0),
          id: source.id,
          kind: 'orders-webhook' as const,
          lastReceivedAt: iso(
            source.lastReceivedAt ?? webhookActivity?.lastReceivedAt,
          ),
          name: source.name,
          status: source.status,
        };
      }),
    ];
  }

  private async jobsInTransaction(
    client: PoolClient,
    organizationId: string,
  ): Promise<GovernanceJob[]> {
    const result = await client.query<JobRow>(
      `SELECT job.id, job.type, job.status,
         job.subject_external_id AS "subjectExternalId",
         job.processed_count::integer AS "processedCount",
         job.failure_code AS "failureCode", job.created_at AS "createdAt",
         job.completed_at AS "completedAt", job.expires_at AS "expiresAt",
         person.display_name AS "requestedByDisplayName"
       FROM governance_jobs job
       JOIN identity_users person ON person.id = job.requested_by_user_id
       WHERE job.organization_id = $1
       ORDER BY job.created_at DESC, job.id DESC LIMIT 50`,
      [organizationId],
    );
    return result.rows.map(mapJob);
  }

  private databaseError<T>(work: () => Promise<T>): Promise<T> {
    return work().catch((error: unknown) => {
      if (isUniqueViolation(error)) {
        throw new ConflictException('A matching active request already exists');
      }
      throw error;
    });
  }
}

function mapSettings(
  row: SettingsRow,
  organization: { name: string; slug: string },
): OrganizationGovernanceSettings {
  return {
    auditRetentionDays: row.auditRetentionDays,
    exportRetentionHours: row.exportRetentionHours,
    name: organization.name,
    operationalDataRetentionDays: row.operationalDataRetentionDays,
    privacyExportRetentionHours: row.privacyExportRetentionHours,
    reportingTimezone: row.reportingTimezone,
    slug: organization.slug,
    updatedAt: iso(row.updatedAt),
    weekStartsOn: row.weekStartsOn,
  };
}

function mapInvitation(row: InvitationRow): OrganizationInvitation {
  return {
    acceptedAt: iso(row.acceptedAt),
    createdAt: row.createdAt.toISOString(),
    email: row.email,
    expiresAt: row.expiresAt.toISOString(),
    id: row.id,
    role: row.role,
    status: row.status,
  };
}

function mapFixedSource(
  id: 'csv' | 'inventory-api' | 'orders-api',
  name: string,
  row?: { eventCount: string; lastReceivedAt: Date | null },
): GovernanceDataSource {
  return {
    eventCount: Number(row?.eventCount ?? 0),
    id,
    kind: id,
    lastReceivedAt: iso(row?.lastReceivedAt),
    name,
    status: row?.lastReceivedAt ? 'active' : 'waiting',
  };
}

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

async function expireInvitations(
  client: PoolClient,
  organizationId: string,
): Promise<void> {
  await client.query(
    `UPDATE organization_invitations SET status = 'expired', updated_at = now()
     WHERE organization_id = $1 AND status = 'pending' AND expires_at <= now()`,
    [organizationId],
  );
}

async function organizationSlug(
  client: PoolClient,
  organizationId: string,
): Promise<string> {
  return required(
    (
      await client.query<{ slug: string }>(
        'SELECT slug FROM organizations WHERE id = $1',
        [organizationId],
      )
    ).rows[0],
    'organization',
  ).slug;
}

async function organizationAccess(
  client: PoolClient,
  organizationId: string,
  role: OrganizationRole,
): Promise<OrganizationAccess> {
  const row = required(
    (
      await client.query<{ id: string; name: string; slug: string }>(
        'SELECT id, name, slug FROM organizations WHERE id = $1',
        [organizationId],
      )
    ).rows[0],
    'organization',
  );
  return { ...row, role };
}

async function audit(
  client: PoolClient,
  event: {
    actorUserId?: string;
    eventType: string;
    metadata?: Record<string, unknown>;
    organizationId?: string;
    targetId?: string;
    targetType?: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events (
       organization_id, actor_user_id, event_type, target_type, target_id, metadata
     ) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      event.organizationId ?? null,
      event.actorUserId ?? null,
      event.eventType,
      event.targetType ?? null,
      event.targetId ?? null,
      event.metadata ?? {},
    ],
  );
}

function decodeCursor(
  value: string | undefined,
  filterHash: string,
): AuditCursor | undefined {
  if (!value) return undefined;
  try {
    const cursor = cursorSchema.parse(
      JSON.parse(Buffer.from(value, 'base64url').toString()),
    );
    if (cursor.filterHash !== filterHash) throw new Error('filter mismatch');
    return cursor;
  } catch {
    throw new BadRequestException(
      'The audit cursor is invalid for these filters',
    );
  }
}

function encodeCursor(row: AuditRow, filterHash: string): string {
  return Buffer.from(
    JSON.stringify({
      createdAt: row.createdAt.toISOString(),
      filterHash,
      id: row.id,
    } satisfies AuditCursor),
  ).toString('base64url');
}

function addFilter(
  where: string[],
  values: unknown[],
  column: string,
  value: string | undefined,
): void {
  if (!value) return;
  values.push(value);
  where.push(`${column} $${values.length}`);
}

function canInvite(
  actor: OrganizationRole,
  target: Exclude<OrganizationRole, 'OWNER'>,
): boolean {
  return actor === 'OWNER' || (actor === 'ADMIN' && target !== 'ADMIN');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function iso(value: Date | null | undefined): string | undefined {
  return value?.toISOString();
}

function required<Row>(row: Row | undefined, label: string): Row {
  if (!row) throw new NotFoundException(`${label} not found`);
  return row;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505'
  );
}
