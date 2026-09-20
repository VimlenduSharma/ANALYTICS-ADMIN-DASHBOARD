export interface QueuePumpOptions {
  drainLimit: number;
  onError: (error: unknown) => void;
  pollMs: number;
  processNext: () => Promise<boolean>;
  shutdownGraceMs: number;
}

export class QueuePump {
  private active?: Promise<void>;
  private stopping = false;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly options: QueuePumpOptions) {}

  start(): void {
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(() => void this.drain(), this.options.pollMs);
    void this.drain();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (!this.active) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.active,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.options.shutdownGraceMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  private drain(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    this.active ??= this.run().finally(() => {
      this.active = undefined;
    });
    return this.active;
  }

  private async run(): Promise<void> {
    try {
      for (
        let processed = 0;
        processed < this.options.drainLimit && !this.stopping;
        processed += 1
      ) {
        if (!(await this.options.processNext())) break;
      }
    } catch (error) {
      this.options.onError(error);
    }
  }
}
