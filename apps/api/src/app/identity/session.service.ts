import type { Environment } from '@analytics-admin/config';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { RedisService } from '../infrastructure/redis.service';

const sessionSchema = z.object({
  absoluteExpiresAt: z.number().int().positive(),
  createdAt: z.number().int().positive(),
  csrfToken: z.string().min(32),
  rotatedAt: z.number().int().positive(),
  userId: z.uuid(),
});

export type SessionRecord = z.infer<typeof sessionSchema>;

export interface ResolvedSession {
  record: SessionRecord;
  token: string;
}

@Injectable()
export class SessionService {
  private readonly absoluteTtl: number;
  private readonly idleTtl: number;
  private readonly rotationAge: number;

  constructor(
    config: ConfigService<Environment, true>,
    private readonly redis: RedisService,
  ) {
    this.absoluteTtl = config.getOrThrow('SESSION_ABSOLUTE_TTL_SECONDS');
    this.idleTtl = config.getOrThrow('SESSION_IDLE_TTL_SECONDS');
    this.rotationAge = config.getOrThrow('SESSION_ROTATION_SECONDS');
  }

  async create(userId: string): Promise<ResolvedSession> {
    const now = epochSeconds();
    const record: SessionRecord = {
      absoluteExpiresAt: now + this.absoluteTtl,
      createdAt: now,
      csrfToken: randomToken(),
      rotatedAt: now,
      userId,
    };
    return this.persist(record);
  }

  async resolve(
    token: string | undefined,
  ): Promise<ResolvedSession | undefined> {
    if (!token) return undefined;
    const key = sessionKey(token);
    const serialized = await this.redis.use((client) => client.get(key));
    if (!serialized) return undefined;

    const parsed = sessionSchema.safeParse(safeJson(serialized));
    if (!parsed.success || parsed.data.absoluteExpiresAt <= epochSeconds()) {
      await this.redis.use((client) => client.del(key));
      return undefined;
    }

    const record = parsed.data;
    if (record.rotatedAt + this.rotationAge <= epochSeconds()) {
      return this.rotate(token, record);
    }

    await this.redis.use((client) =>
      client.expire(key, this.remainingTtl(record)),
    );
    return { record, token };
  }

  async revoke(token: string | undefined): Promise<void> {
    if (!token) return;
    const key = sessionKey(token);
    const serialized = await this.redis.use((client) => client.getDel(key));
    const parsed = sessionSchema.safeParse(safeJson(serialized));
    if (!parsed.success) return;

    await this.redis.use((client) =>
      client.sRem(userSessionsKey(parsed.data.userId), key),
    );
  }

  async revokeAll(userId: string): Promise<void> {
    await this.redis.use(async (client) => {
      const indexKey = userSessionsKey(userId);
      const sessionKeys = await client.sMembers(indexKey);
      const transaction = client.multi();
      for (const key of sessionKeys) transaction.del(key);
      transaction.del(indexKey);
      await transaction.exec();
    });
  }

  private async rotate(
    token: string,
    record: SessionRecord,
  ): Promise<ResolvedSession | undefined> {
    const oldKey = sessionKey(token);
    const claimed = await this.redis.use((client) => client.getDel(oldKey));
    if (!claimed) return undefined;

    const rotated = { ...record, rotatedAt: epochSeconds() };
    const next = await this.persist(rotated);
    await this.redis.use((client) =>
      client.sRem(userSessionsKey(record.userId), oldKey),
    );
    return next;
  }

  private async persist(record: SessionRecord): Promise<ResolvedSession> {
    const token = randomToken();
    const key = sessionKey(token);
    const ttl = this.remainingTtl(record);

    await this.redis.use(async (client) => {
      const indexKey = userSessionsKey(record.userId);
      await client
        .multi()
        .set(key, JSON.stringify(record), { EX: ttl, NX: true })
        .sAdd(indexKey, key)
        .expire(indexKey, ttl)
        .exec();
    });
    return { record, token };
  }

  private remainingTtl(record: SessionRecord): number {
    return Math.max(
      1,
      Math.min(this.idleTtl, record.absoluteExpiresAt - epochSeconds()),
    );
  }
}

function epochSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

function sessionKey(token: string): string {
  return `identity:session:${createHash('sha256').update(token).digest('hex')}`;
}

function userSessionsKey(userId: string): string {
  return `identity:user-sessions:${userId}`;
}

function safeJson(value: string | null): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}
