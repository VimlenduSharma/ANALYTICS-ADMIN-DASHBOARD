import type {
  AuditEventSummary,
  IdentityUser,
  OrganizationAccess,
  OrganizationRole,
  TeamMember,
  TeamResponse,
} from '@analytics-admin/contracts';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../infrastructure/database.service';
import { canAssignRole, canManageMember } from './authorization.policy';

interface OidcIdentity {
  avatarUrl?: string;
  displayName: string;
  email: string;
  issuer: string;
  subject: string;
}

interface TeamMemberRow extends Omit<TeamMember, 'joinedAt'> {
  joinedAt: Date;
}

interface MembershipRow extends TeamMemberRow {
  organizationId: string;
}

interface AuditEventRow extends Omit<AuditEventSummary, 'createdAt'> {
  createdAt: Date;
}

interface RoleRow {
  role: OrganizationRole;
}

@Injectable()
export class IdentityRepository {
  constructor(private readonly database: DatabaseService) {}

  async upsertOidcUser(identity: OidcIdentity): Promise<IdentityUser> {
    return this.database.transaction(async (client) => {
      const result = await client.query<IdentityUser>(
        `
          INSERT INTO identity_users (
            issuer, subject, email, display_name, avatar_url
          ) VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (issuer, subject) DO UPDATE SET
            email = EXCLUDED.email,
            display_name = EXCLUDED.display_name,
            avatar_url = EXCLUDED.avatar_url,
            last_login_at = now(),
            updated_at = now()
          RETURNING
            id,
            email,
            display_name AS "displayName",
            avatar_url AS "avatarUrl"
        `,
        [
          identity.issuer,
          identity.subject,
          identity.email,
          identity.displayName,
          identity.avatarUrl ?? null,
        ],
      );
      const user = result.rows[0];
      if (!user) throw new Error('OIDC user upsert returned no record');

      await this.audit(client, {
        actorUserId: user.id,
        eventType: 'identity.login_succeeded',
        targetId: user.id,
        targetType: 'user',
      });
      return user;
    });
  }

  async findUser(userId: string): Promise<IdentityUser | undefined> {
    const result = await this.database.query<IdentityUser>(
      `
        SELECT
          id,
          email,
          display_name AS "displayName",
          avatar_url AS "avatarUrl"
        FROM identity_users
        WHERE id = $1
      `,
      [userId],
    );
    return result.rows[0];
  }

  async organizationsForUser(userId: string): Promise<OrganizationAccess[]> {
    const result = await this.database.query<OrganizationAccess>(
      `
        SELECT
          organization.id,
          organization.name,
          organization.slug,
          membership.role
        FROM organization_memberships membership
        JOIN organizations organization
          ON organization.id = membership.organization_id
        WHERE membership.user_id = $1 AND organization.status = 'active'
        ORDER BY lower(organization.name), organization.id
      `,
      [userId],
    );
    return result.rows;
  }

  async membershipRole(
    userId: string,
    organizationId: string,
  ): Promise<OrganizationRole | undefined> {
    const result = await this.database.query<RoleRow>(
      `
        SELECT membership.role
        FROM organization_memberships membership
        JOIN organizations organization
          ON organization.id = membership.organization_id
        WHERE
          membership.user_id = $1
          AND membership.organization_id = $2
          AND organization.status = 'active'
      `,
      [userId, organizationId],
    );
    return result.rows[0]?.role;
  }

  async createOrganization(
    actorUserId: string,
    name: string,
  ): Promise<OrganizationAccess> {
    const slug = `${slugify(name)}-${randomBytes(3).toString('hex')}`;

    return this.database.transaction(async (client) => {
      const result = await client.query<OrganizationAccess>(
        `
          INSERT INTO organizations (name, slug, created_by_user_id)
          VALUES ($1, $2, $3)
          RETURNING id, name, slug, 'OWNER'::text AS role
        `,
        [name, slug, actorUserId],
      );
      const organization = result.rows[0];
      if (!organization)
        throw new Error('Organization insert returned no record');

      await client.query(
        `
          INSERT INTO organization_memberships (
            organization_id, user_id, role, created_by_user_id
          ) VALUES ($1, $2, 'OWNER', $2)
        `,
        [organization.id, actorUserId],
      );
      await this.audit(client, {
        actorUserId,
        eventType: 'organization.created',
        organizationId: organization.id,
        targetId: organization.id,
        targetType: 'organization',
      });
      return organization;
    });
  }

  async team(organizationId: string): Promise<TeamResponse> {
    const organization = await this.database.query<
      Pick<OrganizationAccess, 'id' | 'name' | 'slug'>
    >('SELECT id, name, slug FROM organizations WHERE id = $1', [
      organizationId,
    ]);
    const current = organization.rows[0];
    if (!current) throw new NotFoundException('Organization not found');

    const members = await this.database.query<TeamMemberRow>(
      `
        SELECT
          user_record.id AS "userId",
          user_record.email,
          user_record.display_name AS "displayName",
          membership.role,
          membership.joined_at AS "joinedAt"
        FROM organization_memberships membership
        JOIN identity_users user_record ON user_record.id = membership.user_id
        WHERE membership.organization_id = $1
        ORDER BY
          CASE membership.role
            WHEN 'OWNER' THEN 1
            WHEN 'ADMIN' THEN 2
            WHEN 'ANALYST' THEN 3
            ELSE 4
          END,
          lower(user_record.display_name),
          user_record.id
      `,
      [organizationId],
    );
    return {
      members: members.rows.map((member) => ({
        ...member,
        joinedAt: member.joinedAt.toISOString(),
      })),
      organization: current,
    };
  }

  async addMember(input: {
    actorUserId: string;
    email: string;
    organizationId: string;
    role: Exclude<OrganizationRole, 'OWNER'>;
  }): Promise<TeamMember> {
    return this.database.transaction(async (client) => {
      const actorRole = await this.lockMembership(
        client,
        input.organizationId,
        input.actorUserId,
      );
      if (!canAssignRole(actorRole, input.role)) {
        throw new ForbiddenException('Role assignment is not permitted');
      }

      const user = await client.query<IdentityUser>(
        `
          SELECT id, email, display_name AS "displayName"
          FROM identity_users
          WHERE email_normalized = lower($1)
        `,
        [input.email],
      );
      const target = user.rows[0];
      if (!target) {
        throw new NotFoundException(
          'No signed-in directory user matches that email address',
        );
      }

      try {
        const result = await client.query<MembershipRow>(
          `
            INSERT INTO organization_memberships (
              organization_id, user_id, role, created_by_user_id
            ) VALUES ($1, $2, $3, $4)
            RETURNING
              organization_id AS "organizationId",
              user_id AS "userId",
              $5::text AS email,
              $6::text AS "displayName",
              role,
              joined_at AS "joinedAt"
          `,
          [
            input.organizationId,
            target.id,
            input.role,
            input.actorUserId,
            target.email,
            target.displayName,
          ],
        );
        const membership = result.rows[0];
        if (!membership)
          throw new Error('Membership insert returned no record');

        await this.audit(client, {
          actorUserId: input.actorUserId,
          eventType: 'membership.created',
          organizationId: input.organizationId,
          targetId: target.id,
          targetType: 'user',
          metadata: { role: input.role },
        });
        return {
          ...membership,
          joinedAt: membership.joinedAt.toISOString(),
        };
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictException('User is already an organization member');
        }
        throw error;
      }
    });
  }

  async updateMemberRole(input: {
    actorUserId: string;
    organizationId: string;
    role: OrganizationRole;
    targetUserId: string;
  }): Promise<void> {
    await this.database.transaction(async (client) => {
      const actorRole = await this.lockMembership(
        client,
        input.organizationId,
        input.actorUserId,
      );
      const targetRole = await this.lockMembership(
        client,
        input.organizationId,
        input.targetUserId,
      );
      if (
        !canManageMember(actorRole, targetRole) ||
        !canAssignRole(actorRole, input.role)
      ) {
        throw new ForbiddenException('Role change is not permitted');
      }
      if (targetRole === 'OWNER' && input.role !== 'OWNER') {
        await this.assertAnotherOwner(client, input.organizationId);
      }

      await client.query(
        `
          UPDATE organization_memberships
          SET role = $1, updated_at = now()
          WHERE organization_id = $2 AND user_id = $3
        `,
        [input.role, input.organizationId, input.targetUserId],
      );
      await this.audit(client, {
        actorUserId: input.actorUserId,
        eventType: 'membership.role_changed',
        organizationId: input.organizationId,
        targetId: input.targetUserId,
        targetType: 'user',
        metadata: { from: targetRole, to: input.role },
      });
    });
  }

  async removeMember(input: {
    actorUserId: string;
    organizationId: string;
    targetUserId: string;
  }): Promise<void> {
    await this.database.transaction(async (client) => {
      const actorRole = await this.lockMembership(
        client,
        input.organizationId,
        input.actorUserId,
      );
      const targetRole = await this.lockMembership(
        client,
        input.organizationId,
        input.targetUserId,
      );
      if (!canManageMember(actorRole, targetRole)) {
        throw new ForbiddenException('Member removal is not permitted');
      }
      if (targetRole === 'OWNER') {
        await this.assertAnotherOwner(client, input.organizationId);
      }

      await client.query(
        'DELETE FROM organization_memberships WHERE organization_id = $1 AND user_id = $2',
        [input.organizationId, input.targetUserId],
      );
      await this.audit(client, {
        actorUserId: input.actorUserId,
        eventType: 'membership.removed',
        organizationId: input.organizationId,
        targetId: input.targetUserId,
        targetType: 'user',
        metadata: { role: targetRole },
      });
    });
  }

  async auditEvents(
    organizationId: string,
    limit = 50,
  ): Promise<AuditEventSummary[]> {
    const result = await this.database.query<AuditEventRow>(
      `
        SELECT
          event.id::text,
          event.event_type AS "eventType",
          event.target_type AS "targetType",
          event.target_id AS "targetId",
          event.created_at AS "createdAt",
          actor.display_name AS "actorDisplayName"
        FROM audit_events event
        LEFT JOIN identity_users actor ON actor.id = event.actor_user_id
        WHERE event.organization_id = $1
        ORDER BY event.created_at DESC, event.id DESC
        LIMIT $2
      `,
      [organizationId, limit],
    );
    return result.rows.map((event) => ({
      ...event,
      createdAt: event.createdAt.toISOString(),
    }));
  }

  private async lockMembership(
    client: PoolClient,
    organizationId: string,
    userId: string,
  ): Promise<OrganizationRole> {
    const result = await client.query<RoleRow>(
      `
        SELECT role
        FROM organization_memberships
        WHERE organization_id = $1 AND user_id = $2
        FOR UPDATE
      `,
      [organizationId, userId],
    );
    const role = result.rows[0]?.role;
    if (!role) throw new ForbiddenException('Organization access is required');
    return role;
  }

  private async assertAnotherOwner(
    client: PoolClient,
    organizationId: string,
  ): Promise<void> {
    const result = await client.query<{ userId: string }>(
      `
        SELECT user_id AS "userId"
        FROM organization_memberships
        WHERE organization_id = $1 AND role = 'OWNER'
        FOR UPDATE
      `,
      [organizationId],
    );
    if ((result.rowCount ?? 0) <= 1) {
      throw new ConflictException('The organization must retain an owner');
    }
  }

  private async audit(
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
      `
        INSERT INTO audit_events (
          organization_id, actor_user_id, event_type, target_type, target_id, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        event.organizationId ?? null,
        event.actorUserId ?? null,
        event.eventType,
        event.targetType ?? null,
        event.targetId ?? null,
        JSON.stringify(event.metadata ?? {}),
      ],
    );
  }
}

function slugify(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 54) || 'workspace'
  );
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505'
  );
}
