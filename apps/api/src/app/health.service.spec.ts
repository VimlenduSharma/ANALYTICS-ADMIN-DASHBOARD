import type { Environment } from '@analytics-admin/config';
import type { DependencyHealth } from '@analytics-admin/contracts';
import type { ConfigService } from '@nestjs/config';
import { HealthService } from './health.service';
import type { InfrastructureService } from './infrastructure.service';

describe('HealthService', () => {
  const config = {
    getOrThrow: jest.fn().mockReturnValue('0.1.0'),
  } as unknown as ConfigService<Environment, true>;

  const dependencies: Record<'postgres' | 'redis', DependencyHealth> = {
    postgres: { latencyMs: 2, status: 'up' },
    redis: { latencyMs: 1, status: 'up' },
  };

  it('reports readiness only when every dependency is available', async () => {
    const infrastructure = {
      inspect: jest.fn().mockResolvedValue(dependencies),
    } as unknown as InfrastructureService;
    const result = await new HealthService(config, infrastructure).readiness();

    expect(result).toMatchObject({
      dependencies,
      service: 'analytics-api',
      status: 'ok',
      version: '0.1.0',
    });
  });

  it('reports degraded readiness when a dependency is unavailable', async () => {
    const infrastructure = {
      inspect: jest.fn().mockResolvedValue({
        ...dependencies,
        redis: { latencyMs: 1_500, status: 'down' },
      }),
    } as unknown as InfrastructureService;

    await expect(
      new HealthService(config, infrastructure).readiness(),
    ).resolves.toMatchObject({ status: 'degraded' });
  });
});
