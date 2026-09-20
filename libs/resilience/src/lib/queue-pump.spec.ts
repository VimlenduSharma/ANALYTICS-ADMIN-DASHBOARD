import { QueuePump } from './queue-pump';

describe('QueuePump', () => {
  afterEach(() => jest.useRealTimers());

  it('drains only the configured batch before yielding', async () => {
    jest.useFakeTimers();
    const processNext = jest.fn().mockResolvedValue(true);
    const pump = new QueuePump({
      drainLimit: 3,
      onError: jest.fn(),
      pollMs: 1_000,
      processNext,
      shutdownGraceMs: 100,
    });

    pump.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(processNext).toHaveBeenCalledTimes(3);
    await pump.stop();
  });

  it('does not claim more work while shutdown waits for an active job', async () => {
    let finish: (() => void) | undefined;
    const processNext = jest.fn(
      () => new Promise<boolean>((resolve) => (finish = () => resolve(true))),
    );
    const pump = new QueuePump({
      drainLimit: 5,
      onError: jest.fn(),
      pollMs: 1_000,
      processNext,
      shutdownGraceMs: 1_000,
    });

    pump.start();
    const stopping = pump.stop();
    finish?.();
    await stopping;
    expect(processNext).toHaveBeenCalledTimes(1);
  });
});
