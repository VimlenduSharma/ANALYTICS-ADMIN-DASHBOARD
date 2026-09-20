import type {
  DependencyHealth,
  DependencyName,
} from '@analytics-admin/contracts';
import { Injectable } from '@nestjs/common';
import { DatabaseService } from './infrastructure/database.service';
import { RedisService } from './infrastructure/redis.service';

@Injectable()
export class InfrastructureService {
  constructor(
    private readonly database: DatabaseService,
    private readonly redis: RedisService,
  ) {}

  async inspect(): Promise<Record<DependencyName, DependencyHealth>> {
    const [postgres, redis] = await Promise.all([
      this.probe(() => this.database.query('SELECT 1')),
      this.probe(() => this.redis.ping()),
    ]);

    return { postgres, redis };
  }

  private async probe(
    check: () => Promise<unknown>,
  ): Promise<DependencyHealth> {
    const startedAt = performance.now();

    try {
      await check();
      return {
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
        status: 'up',
      };
    } catch {
      return {
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
        status: 'down',
      };
    }
  }
}
