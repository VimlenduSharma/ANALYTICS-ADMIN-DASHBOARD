import type { HealthResponse } from '@analytics-admin/contracts';
import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { HealthService } from './health.service';

@Controller({ path: 'health', version: '1' })
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('live')
  liveness(): HealthResponse {
    return this.health.liveness();
  }

  @Get('ready')
  async readiness(): Promise<HealthResponse> {
    const response = await this.health.readiness();

    if (response.status === 'degraded') {
      throw new ServiceUnavailableException({
        code: 'DEPENDENCY_UNAVAILABLE',
        details: { dependencies: response.dependencies },
        message: 'One or more required dependencies are unavailable',
      });
    }

    return response;
  }
}
