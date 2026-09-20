import type { Environment } from '@analytics-admin/config';
import {
  Injectable,
  OnApplicationShutdown,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Pool,
  type PoolClient,
  type QueryResult,
  type QueryResultRow,
} from 'pg';
import { applyMigrations, verifyMigrations } from './migration-gate';

export interface DatabasePoolSnapshot {
  idle: number;
  max: number;
  total: number;
  waiting: number;
}

@Injectable()
export class DatabaseService implements OnModuleInit, OnApplicationShutdown {
  private readonly maxPoolSize: number;
  private readonly maxWaiting: number;
  private readonly pool: Pool;
  private readonly production: boolean;

  constructor(config: ConfigService<Environment, true>) {
    this.production = config.getOrThrow('NODE_ENV') === 'production';
    this.maxPoolSize = config.getOrThrow('DATABASE_POOL_MAX');
    this.maxWaiting = config.getOrThrow('DATABASE_POOL_MAX_WAITING');
    this.pool = new Pool({
      application_name: config.get('SERVICE_NAME') ?? 'analytics-admin',
      connectionString: config.getOrThrow('DATABASE_URL'),
      connectionTimeoutMillis: config.getOrThrow(
        'DATABASE_CONNECTION_TIMEOUT_MS',
      ),
      idleTimeoutMillis: config.getOrThrow('DATABASE_IDLE_TIMEOUT_MS'),
      max: this.maxPoolSize,
      min: config.getOrThrow('DATABASE_POOL_MIN'),
      statement_timeout: config.getOrThrow('DATABASE_STATEMENT_TIMEOUT_MS'),
    });
  }

  async onModuleInit(): Promise<void> {
    this.assertCapacity();
    const client = await this.pool.connect();
    try {
      if (this.production) await verifyMigrations(client);
      else await applyMigrations(client);
    } finally {
      client.release();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }

  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    this.assertCapacity();
    return this.pool.query<Row>(text, [...values]);
  }

  poolSnapshot(): DatabasePoolSnapshot {
    return {
      idle: this.pool.idleCount,
      max: this.maxPoolSize,
      total: this.pool.totalCount,
      waiting: this.pool.waitingCount,
    };
  }

  async transaction<Result>(
    work: (client: PoolClient) => Promise<Result>,
    begin = 'BEGIN',
  ): Promise<Result> {
    this.assertCapacity();
    const client = await this.pool.connect();
    try {
      await client.query(begin);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  tenantTransaction<Result>(
    organizationId: string,
    work: (client: PoolClient) => Promise<Result>,
  ): Promise<Result> {
    return this.transaction(async (client) => {
      await client.query("SELECT set_config('app.organization_id', $1, true)", [
        organizationId,
      ]);
      return work(client);
    });
  }

  tenantReadTransaction<Result>(
    organizationId: string,
    work: (client: PoolClient) => Promise<Result>,
  ): Promise<Result> {
    return this.transaction(async (client) => {
      await client.query("SELECT set_config('app.organization_id', $1, true)", [
        organizationId,
      ]);
      return work(client);
    }, 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  }

  private assertCapacity(): void {
    if (this.pool.waitingCount < this.maxWaiting) return;
    throw new ServiceUnavailableException({
      code: 'DATABASE_POOL_SATURATED',
      message: 'Database capacity is temporarily saturated',
    });
  }
}
