import {
  CircuitBreaker,
  CircuitOpenError,
  CircuitTimeoutError,
} from './circuit-breaker';

describe('CircuitBreaker', () => {
  it('opens after consecutive failures and recovers through one probe', async () => {
    let now = 1_000;
    const circuit = new CircuitBreaker(
      'redis',
      { failureThreshold: 2, resetAfterMs: 500, timeoutMs: 100 },
      () => now,
    );
    const failure = async () => Promise.reject(new Error('unavailable'));

    await expect(circuit.execute(failure)).rejects.toThrow('unavailable');
    await expect(circuit.execute(failure)).rejects.toThrow('unavailable');
    await expect(circuit.execute(async () => 'blocked')).rejects.toBeInstanceOf(
      CircuitOpenError,
    );
    expect(circuit.snapshot()).toMatchObject({ failures: 2, state: 'open' });

    now += 500;
    await expect(circuit.execute(async () => 'recovered')).resolves.toBe(
      'recovered',
    );
    expect(circuit.snapshot()).toEqual({ failures: 0, state: 'closed' });
  });

  it('bounds an unresponsive dependency call', async () => {
    jest.useFakeTimers();
    const circuit = new CircuitBreaker('provider', {
      failureThreshold: 1,
      resetAfterMs: 500,
      timeoutMs: 100,
    });
    const result = circuit.execute(() => new Promise(() => undefined));
    const assertion =
      expect(result).rejects.toBeInstanceOf(CircuitTimeoutError);
    await jest.advanceTimersByTimeAsync(100);
    await assertion;
    jest.useRealTimers();
  });
});
