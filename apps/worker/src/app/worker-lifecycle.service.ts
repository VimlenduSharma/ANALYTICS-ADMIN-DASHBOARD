import type { Environment } from '@analytics-admin/config';
import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class WorkerLifecycleService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(WorkerLifecycleService.name);
  private heartbeat?: ReturnType<typeof setInterval>;

  constructor(private readonly config: ConfigService<Environment, true>) {}

  onApplicationBootstrap(): void {
    const interval = this.config.getOrThrow('WORKER_HEARTBEAT_MS');
    this.heartbeat = setInterval(
      () => this.logger.debug('Worker heartbeat'),
      interval,
    );
    this.logger.log('Analytics worker is ready');
  }

  onApplicationShutdown(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.logger.log('Analytics worker stopped cleanly');
  }
}
