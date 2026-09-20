export type CircuitState = 'closed' | 'half-open' | 'open';

export interface CircuitSnapshot {
  failures: number;
  openedAt?: string;
  state: CircuitState;
}

export interface CircuitBreakerOptions {
  failureThreshold: number;
  resetAfterMs: number;
  timeoutMs: number;
}

export class CircuitOpenError extends Error {
  constructor(readonly circuit: string) {
    super(`${circuit} circuit is open`);
    this.name = 'CircuitOpenError';
  }
}

export class CircuitTimeoutError extends Error {
  constructor(
    readonly circuit: string,
    readonly timeoutMs: number,
  ) {
    super(`${circuit} exceeded its ${timeoutMs}ms timeout`);
    this.name = 'CircuitTimeoutError';
  }
}

export class CircuitBreaker {
  private failures = 0;
  private openedAt?: number;
  private probeInFlight = false;

  constructor(
    readonly name: string,
    private readonly options: CircuitBreakerOptions,
    private readonly now: () => number = Date.now,
  ) {}

  snapshot(): CircuitSnapshot {
    return {
      failures: this.failures,
      ...(this.openedAt
        ? { openedAt: new Date(this.openedAt).toISOString() }
        : {}),
      state: this.state(),
    };
  }

  async execute<Result>(operation: () => Promise<Result>): Promise<Result> {
    const state = this.state();
    if (state === 'open' || (state === 'half-open' && this.probeInFlight)) {
      throw new CircuitOpenError(this.name);
    }

    const probing = state === 'half-open';
    if (probing) this.probeInFlight = true;

    try {
      const result = await withTimeout(
        operation(),
        this.options.timeoutMs,
        () => new CircuitTimeoutError(this.name, this.options.timeoutMs),
      );
      this.failures = 0;
      this.openedAt = undefined;
      return result;
    } catch (error) {
      this.failures += 1;
      if (probing || this.failures >= this.options.failureThreshold) {
        this.openedAt = this.now();
      }
      throw error;
    } finally {
      if (probing) this.probeInFlight = false;
    }
  }

  private state(): CircuitState {
    if (this.openedAt === undefined) return 'closed';
    return this.now() - this.openedAt >= this.options.resetAfterMs
      ? 'half-open'
      : 'open';
  }
}

async function withTimeout<Result>(
  operation: Promise<Result>,
  timeoutMs: number,
  timeoutError: () => Error,
): Promise<Result> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(timeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
