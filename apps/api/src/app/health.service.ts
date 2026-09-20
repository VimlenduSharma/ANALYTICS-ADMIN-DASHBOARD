import type { Environment } from '@analytics-admin/config';
import type { HealthResponse, ServiceStatus } from '@analytics-admin/contracts';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InfrastructureService } from './infrastructure.service';

@Injectable()
export class HealthService {
  constructor(
    private readonly config: ConfigService<Environment, true>,
    private readonly infrastructure: InfrastructureService,
  ) {}

  liveness(): HealthResponse {
    return this.response('ok');
  }

  async readiness(): Promise<HealthResponse> {
    const dependencies = await this.infrastructure.inspect();
    const status = Object.values(dependencies).every(
      ({ status }) => status === 'up',
    )
      ? 'ok'
      : 'degraded';

    return { ...this.response(status), dependencies };
  }

  private response(status: ServiceStatus): HealthResponse {
    return {
      service: 'analytics-api',
      status,
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      version: this.config.getOrThrow('APP_VERSION'),
    };
  }
}
