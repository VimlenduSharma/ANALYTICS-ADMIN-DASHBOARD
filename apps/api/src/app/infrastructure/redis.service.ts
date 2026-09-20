import type { Environment } from '@analytics-admin/config';
import {
  CircuitBreaker,
  type CircuitSnapshot,
} from '@analytics-admin/resilience';
import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from 'redis';

function buildRedisClient(url: string, connectTimeout: number) {
  return createClient({
    socket: { connectTimeout, reconnectStrategy: false },
    url,
  });
}

export type RedisClient = ReturnType<typeof buildRedisClient>;

@Injectable()
export class RedisService implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisService.name);
  private readonly circuit: CircuitBreaker;
  private readonly connectTimeout: number;
  private readonly url: string;
  private client?: RedisClient;
  private connecting?: Promise<void>;

  constructor(config: ConfigService<Environment, true>) {
    this.url = config.getOrThrow('REDIS_URL');
    this.connectTimeout = config.getOrThrow('DEPENDENCY_TIMEOUT_MS');
    this.circuit = new CircuitBreaker('redis', {
      failureThreshold: config.getOrThrow('CIRCUIT_FAILURE_THRESHOLD'),
      resetAfterMs: config.getOrThrow('CIRCUIT_RESET_MS'),
      timeoutMs: this.connectTimeout,
    });
  }

  async use<Result>(
    operation: (client: RedisClient) => Promise<Result>,
  ): Promise<Result> {
    try {
      return await this.circuit.execute(async () => {
        const client = await this.connectedClient();
        return operation(client);
      });
    } catch {
      throw new ServiceUnavailableException({
        code: 'REDIS_UNAVAILABLE',
        message:
          'Session and coordination services are temporarily unavailable',
      });
    }
  }

  circuitSnapshot(): CircuitSnapshot {
    return this.circuit.snapshot();
  }

  async ping(): Promise<void> {
    await this.use(async (client) => {
      await client.ping();
    });
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.client) return;
    if (this.client.isOpen) await this.client.quit();
    else this.client.destroy();
  }

  private async connectedClient(): Promise<RedisClient> {
    const client = this.client ?? this.createClient();
    if (client.isReady) return client;

    this.connecting ??= client.connect().then(() => undefined);
    try {
      await this.connecting;
      return client;
    } catch (error) {
      client.destroy();
      this.client = undefined;
      throw error;
    } finally {
      this.connecting = undefined;
    }
  }

  private createClient(): RedisClient {
    const client = buildRedisClient(this.url, this.connectTimeout);
    client.on('error', () =>
      this.logger.warn('Redis connection is unavailable'),
    );
    this.client = client;
    return client;
  }
}
