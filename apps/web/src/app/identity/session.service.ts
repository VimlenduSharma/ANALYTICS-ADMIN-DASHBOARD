import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import type { SessionResponse } from '@analytics-admin/contracts';
import { firstValueFrom, timeout } from 'rxjs';
import { CsrfTokenStore } from './csrf-token.store';

export type SessionState =
  | { kind: 'loading' }
  | { kind: 'anonymous'; loginAvailable: boolean }
  | {
      kind: 'authenticated';
      session: Extract<SessionResponse, { authenticated: true }>;
    }
  | { kind: 'error'; message: string };

@Injectable({ providedIn: 'root' })
export class SessionService {
  private readonly csrf = inject(CsrfTokenStore);
  private readonly http = inject(HttpClient);
  private readonly stateSignal = signal<SessionState>({ kind: 'loading' });
  private loadPromise?: Promise<SessionState>;

  readonly state = this.stateSignal.asReadonly();
  readonly user = computed(() => {
    const state = this.stateSignal();
    return state.kind === 'authenticated' ? state.session.user : undefined;
  });
  readonly organizations = computed(() => {
    const state = this.stateSignal();
    return state.kind === 'authenticated' ? state.session.organizations : [];
  });

  ensureLoaded(force = false): Promise<SessionState> {
    if (!force && this.loadPromise) return this.loadPromise;
    this.stateSignal.set({ kind: 'loading' });
    this.loadPromise = this.fetchSession();
    return this.loadPromise;
  }

  async signOut(): Promise<void> {
    try {
      await firstValueFrom(
        this.http.post<void>('/api/v1/auth/logout', {}).pipe(timeout(5_000)),
      );
    } finally {
      this.csrf.clear();
      this.loadPromise = undefined;
      this.stateSignal.set({ kind: 'anonymous', loginAvailable: true });
      location.assign('/sign-in');
    }
  }

  expire(): void {
    this.csrf.clear();
    this.loadPromise = undefined;
    this.stateSignal.set({ kind: 'anonymous', loginAvailable: true });
  }

  private async fetchSession(): Promise<SessionState> {
    try {
      const session = await firstValueFrom(
        this.http
          .get<SessionResponse>('/api/v1/auth/session')
          .pipe(timeout(5_000)),
      );
      const state: SessionState = session.authenticated
        ? { kind: 'authenticated', session }
        : {
            kind: 'anonymous',
            loginAvailable: session.loginAvailable,
          };
      if (session.authenticated) this.csrf.set(session.csrfToken);
      else this.csrf.clear();
      this.stateSignal.set(state);
      return state;
    } catch (error) {
      const state: SessionState = {
        kind: 'error',
        message:
          error instanceof HttpErrorResponse && error.status === 0
            ? 'The identity service is unreachable. Check the API and try again.'
            : 'Your session could not be verified. Try again in a moment.',
      };
      this.csrf.clear();
      this.stateSignal.set(state);
      return state;
    }
  }
}
