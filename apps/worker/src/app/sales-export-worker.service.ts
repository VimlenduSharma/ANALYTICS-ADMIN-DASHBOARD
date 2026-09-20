import type { Environment } from '@analytics-admin/config';
import { SalesExportService } from '@analytics-admin/sales';
import { QueuePump } from '@analytics-admin/resilience';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class SalesExportWorkerService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(SalesExportWorkerService.name);
  private readonly pump: QueuePump;

  constructor(
    config: ConfigService<Environment, true>,
    private readonly exports: SalesExportService,
  ) {
    this.pump = new QueuePump({
      drainLimit: config.getOrThrow('QUEUE_DRAIN_LIMIT'),
      onError: (error) => this.logError(error),
      pollMs: config.getOrThrow('SALES_EXPORT_POLL_MS'),
      processNext: () => this.exports.processNext(),
      shutdownGraceMs: config.getOrThrow('WORKER_SHUTDOWN_GRACE_MS'),
    });
  }

  onApplicationBootstrap(): void {
    this.pump.start();
  }

  onApplicationShutdown(): Promise<void> {
    return this.pump.stop();
  }

  private logError(error: unknown): void {
    this.logger.error(
      'Sales export queue processing failed',
      error instanceof Error ? error.stack : undefined,
    );
  }
}
