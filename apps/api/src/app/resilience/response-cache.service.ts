import type { Environment } from '@analytics-admin/config';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { RedisService } from '../infrastructure/redis.service';
import { MetricsService } from './metrics.service';

export interface CacheResult<Value> {
  status: 'BYPASS' | 'HIT' | 'MISS';
  value: Value;
}

@Injectable()
export class ResponseCacheService {
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly logger = new Logger(ResponseCacheService.name);
  private readonly ttlSeconds: number;

  constructor(
    config: ConfigService<Environment, true>,
    private readonly metrics: MetricsService,
    private readonly redis: RedisService,
  ) {
    this.ttlSeconds = config.getOrThrow('CACHE_TTL_SECONDS');
  }

  async getOrLoad<Value>(
    namespace: string,
    organizationId: string,
    input: unknown,
    load: () => Promise<Value>,
  ): Promise<CacheResult<Value>> {
    let key: string;
    try {
      const generation = await this.generation(organizationId);
      key = cacheKey(namespace, organizationId, generation, input);
      const cached = await this.redis.use((client) => client.get(key));
      if (cached) {
        this.metrics.observeCache('hit');
        return { status: 'HIT', value: JSON.parse(cached) as Value };
      }
    } catch {
      this.logger.warn('Response cache unavailable; serving from the source');
      this.metrics.observeCache('bypass');
      return { status: 'BYPASS', value: await load() };
    }

    const pending = this.inFlight.get(key) as Promise<Value> | undefined;
    const value = pending ?? this.loadAndStore(key, load);
    if (!pending) this.inFlight.set(key, value);
    try {
      const resolved = await value;
      this.metrics.observeCache('miss');
      return { status: 'MISS', value: resolved };
    } finally {
      if (!pending) this.inFlight.delete(key);
    }
  }

  async invalidateOrganization(organizationId: string): Promise<void> {
    try {
      await this.redis.use((client) =>
        client.incr(generationKey(organizationId)),
      );
    } catch {
      this.logger.warn('Cache invalidation skipped while Redis is unavailable');
    }
  }

  private generation(organizationId: string): Promise<string> {
    return this.redis.use(async (client) => {
      const key = generationKey(organizationId);
      const generation = await client.get(key);
      if (generation) return generation;
      await client.set(key, '0', { NX: true });
      return (await client.get(key)) ?? '0';
    });
  }

  private async loadAndStore<Value>(
    key: string,
    load: () => Promise<Value>,
  ): Promise<Value> {
    const value = await load();
    try {
      await this.redis.use((client) =>
        client.set(key, JSON.stringify(value), { EX: this.ttlSeconds }),
      );
    } catch {
      this.logger.warn(
        'Response cache write skipped while Redis is unavailable',
      );
    }
    return value;
  }
}

function cacheKey(
  namespace: string,
  organizationId: string,
  generation: string,
  input: unknown,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex');
  return `resilience:cache:${organizationId}:${generation}:${namespace}:${digest}`;
}

function generationKey(organizationId: string): string {
  return `resilience:cache-generation:${organizationId}`;
}
