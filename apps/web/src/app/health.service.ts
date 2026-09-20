import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { inject, Injectable, signal } from '@angular/core';
import type { HealthResponse } from '@analytics-admin/contracts';
import { take, timeout } from 'rxjs';

export type HealthState =
  | { kind: 'loading' }
  | { data: HealthResponse; kind: 'resolved' }
  | { kind: 'error'; message: string };

@Injectable({ providedIn: 'root' })
export class HealthService {
  private readonly http = inject(HttpClient);
  private readonly stateSignal = signal<HealthState>({ kind: 'loading' });

  readonly state = this.stateSignal.asReadonly();

  constructor() {
    this.refresh();
  }

  refresh(): void {
    this.stateSignal.set({ kind: 'loading' });
    this.http
      .get<HealthResponse>('/api/v1/health/ready')
      .pipe(timeout(4_000), take(1))
      .subscribe({
        next: (data) => this.stateSignal.set({ data, kind: 'resolved' }),
        error: (error: unknown) => this.resolveError(error),
      });
  }

  private resolveError(error: unknown): void {
    if (error instanceof HttpErrorResponse && isHealthResponse(error.error)) {
      this.stateSignal.set({ data: error.error, kind: 'resolved' });
      return;
    }

    this.stateSignal.set({
      kind: 'error',
      message:
        'The readiness check did not respond. Confirm the local API and infrastructure are running, then retry.',
    });
  }
}

function isHealthResponse(value: unknown): value is HealthResponse {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<HealthResponse>;
  return (
    candidate.service === 'analytics-api' && candidate.status === 'degraded'
  );
}
