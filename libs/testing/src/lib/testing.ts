import type { HealthResponse } from '@analytics-admin/contracts';

export const healthyResponse: HealthResponse = {
  dependencies: {
    postgres: { latencyMs: 4, status: 'up' },
    redis: { latencyMs: 2, status: 'up' },
  },
  service: 'analytics-api',
  status: 'ok',
  timestamp: '2026-09-02T00:00:00.000Z',
  uptimeSeconds: 120,
  version: '0.1.0',
};
