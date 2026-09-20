import type { Environment } from '@analytics-admin/config';
import type { ConfigService } from '@nestjs/config';
import { WorkerLifecycleService } from './worker-lifecycle.service';

describe('WorkerLifecycleService', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('starts and clears one heartbeat timer', () => {
    const config = {
      getOrThrow: jest.fn().mockReturnValue(60_000),
    } as unknown as ConfigService<Environment, true>;
    const worker = new WorkerLifecycleService(config);

    worker.onApplicationBootstrap();
    expect(jest.getTimerCount()).toBe(1);

    worker.onApplicationShutdown();
    expect(jest.getTimerCount()).toBe(0);
  });
});
