import type { Environment } from '@analytics-admin/config';
import { CredentialCipher } from '@analytics-admin/governance';
import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createHmac,
  createSecretKey,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { DatabaseService } from '../infrastructure/database.service';

export interface WebhookEndpoint {
  credentialRotatedAt?: string;
  createdAt: string;
  id: string;
  lastReceivedAt?: string;
  name: string;
  status: 'active' | 'revoked';
}

export interface CreatedWebhookEndpoint extends WebhookEndpoint {
  path: string;
  secret: string;
}

interface WebhookEndpointRow extends Omit<
  WebhookEndpoint,
  'createdAt' | 'credentialRotatedAt' | 'lastReceivedAt'
> {
  credentialRotatedAt: Date | null;
  createdAt: Date;
  lastReceivedAt: Date | null;
}

interface StoredCredential {
  active: boolean;
  authTag: Buffer | null;
  ciphertext: Buffer | null;
  iv: Buffer | null;
  version: number;
}

@Injectable()
export class WebhookService {
  private readonly clockTolerance: number;
  private readonly masterKey: ReturnType<typeof createSecretKey>;

  constructor(
    config: ConfigService<Environment, true>,
    private readonly cipher: CredentialCipher,
    private readonly database: DatabaseService,
  ) {
    this.clockTolerance = config.getOrThrow('WEBHOOK_CLOCK_TOLERANCE_SECONDS');
    this.masterKey = createSecretKey(
      Buffer.from(
        config.getOrThrow<string>('WEBHOOK_SIGNING_KEY'),
        'base64url',
      ),
    );
  }

  async create(
    organizationId: string,
    actorUserId: string,
    name: string,
  ): Promise<CreatedWebhookEndpoint> {
    const id = randomUUID();
    const secret = randomBytes(32).toString('base64url');
    const encrypted = this.cipher.encrypt(
      secret,
      credentialContext(organizationId, id, 1),
    );
    const endpoint = await this.database.tenantTransaction(
      organizationId,
      async (client) => {
        const result = await client.query<WebhookEndpointRow>(
          `
            INSERT INTO webhook_endpoints (
              id, organization_id, name, created_by_user_id,
              credential_ciphertext, credential_iv, credential_auth_tag,
              credential_version, credential_rotated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, 1, now())
            RETURNING id, name, status, created_at AS "createdAt",
              credential_rotated_at AS "credentialRotatedAt",
              last_received_at AS "lastReceivedAt"
          `,
          [
            id,
            organizationId,
            name,
            actorUserId,
            encrypted.ciphertext,
            encrypted.iv,
            encrypted.authTag,
          ],
        );
        await client.query(
          `
            INSERT INTO audit_events (
              organization_id, actor_user_id, event_type, target_type, target_id
            ) VALUES ($1, $2, 'data.webhook_created', 'webhook_endpoint', $3)
          `,
          [organizationId, actorUserId, id],
        );
        const created = result.rows[0];
        if (!created) throw new Error('Webhook endpoint was not persisted');
        return mapEndpoint(created);
      },
    );
    return {
      ...endpoint,
      path: `/api/v1/organizations/${organizationId}/webhooks/orders/${id}`,
      secret,
    };
  }

  list(organizationId: string): Promise<WebhookEndpoint[]> {
    return this.database.tenantTransaction(organizationId, async (client) => {
      const result = await client.query<WebhookEndpointRow>(
        `
          SELECT id, name, status, created_at AS "createdAt",
            credential_rotated_at AS "credentialRotatedAt",
            last_received_at AS "lastReceivedAt"
          FROM webhook_endpoints
          WHERE organization_id = $1
          ORDER BY created_at DESC, id DESC
        `,
        [organizationId],
      );
      return result.rows.map(mapEndpoint);
    });
  }

  revoke(
    organizationId: string,
    endpointId: string,
    actorUserId: string,
  ): Promise<void> {
    return this.database.tenantTransaction(organizationId, async (client) => {
      await client.query(
        `
          UPDATE webhook_endpoints
          SET status = 'revoked', revoked_at = COALESCE(revoked_at, now())
          WHERE organization_id = $1 AND id = $2
        `,
        [organizationId, endpointId],
      );
      await client.query(
        `
          INSERT INTO audit_events (
            organization_id, actor_user_id, event_type, target_type, target_id
          ) VALUES ($1, $2, 'data.webhook_revoked', 'webhook_endpoint', $3)
        `,
        [organizationId, actorUserId, endpointId],
      );
    });
  }

  rotate(
    organizationId: string,
    endpointId: string,
    actorUserId: string,
  ): Promise<CreatedWebhookEndpoint> {
    return this.database.tenantTransaction(organizationId, async (client) => {
      const current = await client.query<{
        createdAt: Date;
        name: string;
        status: 'active' | 'revoked';
        version: number;
      }>(
        `SELECT name, status, created_at AS "createdAt",
           credential_version AS version
         FROM webhook_endpoints
         WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
        [organizationId, endpointId],
      );
      const endpoint = current.rows[0];
      if (!endpoint || endpoint.status !== 'active') {
        throw new NotFoundException('Active webhook endpoint not found');
      }
      const version = endpoint.version + 1;
      const secret = randomBytes(32).toString('base64url');
      const encrypted = this.cipher.encrypt(
        secret,
        credentialContext(organizationId, endpointId, version),
      );
      const result = await client.query<WebhookEndpointRow>(
        `UPDATE webhook_endpoints SET
           credential_ciphertext = $3, credential_iv = $4,
           credential_auth_tag = $5, credential_version = $6,
           credential_rotated_at = now()
         WHERE organization_id = $1 AND id = $2
         RETURNING id, name, status, created_at AS "createdAt",
           credential_rotated_at AS "credentialRotatedAt",
           last_received_at AS "lastReceivedAt"`,
        [
          organizationId,
          endpointId,
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.authTag,
          version,
        ],
      );
      await client.query(
        `INSERT INTO audit_events (
           organization_id, actor_user_id, event_type, target_type, target_id,
           metadata
         ) VALUES ($1, $2, 'data.webhook_credential_rotated',
           'webhook_endpoint', $3, jsonb_build_object('version', $4::integer))`,
        [organizationId, actorUserId, endpointId, version],
      );
      return {
        ...mapEndpoint(required(result.rows[0])),
        path: `/api/v1/organizations/${organizationId}/webhooks/orders/${endpointId}`,
        secret,
      };
    });
  }

  async verify(input: {
    endpointId: string;
    organizationId: string;
    rawBody: Buffer;
    signature: string;
    timestamp: string;
  }): Promise<void> {
    const timestamp = Number(input.timestamp);
    const now = Math.floor(Date.now() / 1_000);
    if (
      !Number.isInteger(timestamp) ||
      Math.abs(now - timestamp) > this.clockTolerance
    ) {
      throw invalidSignature();
    }

    const credential = await this.database.tenantTransaction(
      input.organizationId,
      async (client) => {
        const result = await client.query<StoredCredential>(
          `
            SELECT status = 'active' AS active,
              credential_ciphertext AS ciphertext,
              credential_iv AS iv, credential_auth_tag AS "authTag",
              credential_version AS version
            FROM webhook_endpoints
            WHERE organization_id = $1 AND id = $2
          `,
          [input.organizationId, input.endpointId],
        );
        return result.rows[0];
      },
    );
    if (!credential?.active) throw invalidSignature();

    const providedHex = input.signature.startsWith('v1=')
      ? input.signature.slice(3)
      : '';
    if (!/^[0-9a-f]{64}$/i.test(providedHex)) throw invalidSignature();

    const secret =
      credential.version > 0
        ? Buffer.from(
            this.cipher
              .decrypt(
                {
                  authTag: required(credential.authTag),
                  ciphertext: required(credential.ciphertext),
                  iv: required(credential.iv),
                },
                credentialContext(
                  input.organizationId,
                  input.endpointId,
                  credential.version,
                ),
              )
              .toString('utf8'),
            'base64url',
          )
        : this.deriveSecret(input.endpointId);
    const expected = createHmac('sha256', secret)
      .update(`${input.timestamp}.`)
      .update(input.rawBody)
      .digest();
    const provided = Buffer.from(providedHex, 'hex');
    if (
      provided.length !== expected.length ||
      !timingSafeEqual(provided, expected)
    ) {
      throw invalidSignature();
    }
    await this.database.tenantTransaction(input.organizationId, (client) =>
      client.query(
        `UPDATE webhook_endpoints SET last_received_at = now()
         WHERE organization_id = $1 AND id = $2`,
        [input.organizationId, input.endpointId],
      ),
    );
  }

  private deriveSecret(endpointId: string): Buffer {
    return createHmac('sha256', this.masterKey)
      .update(`analytics-orders:${endpointId}`)
      .digest();
  }
}

function mapEndpoint(row: WebhookEndpointRow): WebhookEndpoint {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    credentialRotatedAt: row.credentialRotatedAt?.toISOString(),
    lastReceivedAt: row.lastReceivedAt?.toISOString(),
  };
}

function credentialContext(
  organizationId: string,
  endpointId: string,
  version: number,
): string {
  return `webhook:${organizationId}:${endpointId}:${version}`;
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw invalidSignature();
  return value;
}

function invalidSignature(): UnauthorizedException {
  return new UnauthorizedException({
    code: 'WEBHOOK_SIGNATURE_INVALID',
    message: 'The webhook signature is invalid or expired',
  });
}
