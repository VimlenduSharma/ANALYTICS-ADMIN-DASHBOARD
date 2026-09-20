import { Injectable, signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class CsrfTokenStore {
  private readonly tokenSignal = signal<string | undefined>(undefined);
  readonly token = this.tokenSignal.asReadonly();

  clear(): void {
    this.tokenSignal.set(undefined);
  }

  set(token: string): void {
    this.tokenSignal.set(token);
  }
}
