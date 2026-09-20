import type { Environment } from '@analytics-admin/config';
import {
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { RedisService } from '../infrastructure/redis.service';
import { trustedClientIdentity } from '../common/edge-origin';

const consumeScript = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return {count, redis.call('TTL', KEYS[1])}
`;

@Injectable()
export class RateLimitService {
  private readonly edgeProxyEnabled: boolean;
  private readonly limits: Record<'api' | 'auth' | 'webhook', number>;
  private readonly windowSeconds: number;

  constructor(
    config: ConfigService<Environment, true>,
    private readonly redis: RedisService,
  ) {
    this.edgeProxyEnabled = Boolean(config.get('EDGE_PROXY_SECRET'));
    this.windowSeconds = config.getOrThrow('RATE_LIMIT_WINDOW_SECONDS');
    this.limits = {
      api: config.getOrThrow('RATE_LIMIT_API_MAX'),
      auth: config.getOrThrow('RATE_LIMIT_AUTH_MAX'),
      webhook: config.getOrThrow('RATE_LIMIT_WEBHOOK_MAX'),
    };
  }

  async enforce(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const path = request.url.split('?', 1)[0] ?? request.url;
    if (isExempt(path)) return;

    const bucket = path.includes('/webhooks/orders/')
      ? 'webhook'
      : path.includes('/auth/')
        ? 'auth'
        : 'api';
    const limit = this.limits[bucket];
    const identity =
      request.cookies.aad_session ??
      request.cookies['__Host-aad_session'] ??
      trustedClientIdentity(request, this.edgeProxyEnabled);
    const digest = createHash('sha256').update(identity).digest('hex');
    const window = Math.floor(Date.now() / (this.windowSeconds * 1_000));

    let result: unknown;
    try {
      result = await this.redis.use((client) =>
        client.eval(consumeScript, {
          arguments: [String(this.windowSeconds)],
          keys: [`resilience:rate:${bucket}:${window}:${digest}`],
        }),
      );
    } catch {
      throw new ServiceUnavailableException({
        code: 'RATE_LIMIT_UNAVAILABLE',
        message: 'Request admission is temporarily unavailable',
      });
    }

    const [count = limit + 1, ttl = this.windowSeconds] = Array.isArray(result)
      ? result.map(Number)
      : [];
    reply.headers({
      'x-ratelimit-limit': limit,
      'x-ratelimit-remaining': Math.max(0, limit - count),
      'x-ratelimit-reset': Math.floor(Date.now() / 1_000) + Math.max(1, ttl),
    });
    if (count <= limit) return;

    reply.header('retry-after', Math.max(1, ttl));
    throw new HttpException(
      {
        code: 'RATE_LIMITED',
        message: 'Too many requests; retry after the indicated interval',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

function isExempt(path: string): boolean {
  return (
    path.endsWith('/health/live') ||
    path.endsWith('/health/ready') ||
    path.endsWith('/observability/metrics') ||
    path.endsWith('/openapi.json')
  );
}
