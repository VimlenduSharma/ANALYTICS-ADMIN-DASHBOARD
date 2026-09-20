import { DOCUMENT } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import type { OrganizationAccess } from '@analytics-admin/contracts';
import { firstValueFrom, timeout } from 'rxjs';
import { SessionService } from '../../identity/session.service';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  styleUrl: './accept-invitation.css',
  templateUrl: './accept-invitation.html',
})
export class AcceptInvitationPage {
  private readonly document = inject(DOCUMENT);
  private readonly http = inject(HttpClient);
  private readonly route = inject(ActivatedRoute);
  protected readonly session = inject(SessionService);
  protected readonly pending = signal(false);
  protected readonly error = signal<string | undefined>(undefined);
  protected readonly accepted = signal(false);
  protected readonly organizationId =
    this.route.snapshot.paramMap.get('organizationId') ?? '';
  protected readonly token: string | undefined;

  constructor() {
    const token = new URLSearchParams(this.route.snapshot.fragment ?? '').get(
      'token',
    );
    this.token = token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
    const window = this.document.defaultView;
    if (window?.location.hash) {
      window.history.replaceState(
        window.history.state,
        '',
        window.location.pathname + window.location.search,
      );
    }
    if (!this.token) {
      this.error.set(
        'This link is incomplete. Ask the owner for a new invitation.',
      );
    }
  }

  protected async accept(): Promise<void> {
    if (!this.token || !this.organizationId || this.pending()) return;
    this.pending.set(true);
    this.error.set(undefined);
    try {
      await firstValueFrom(
        this.http
          .post<OrganizationAccess>(
            `/api/v1/organizations/${this.organizationId}/invitations/accept`,
            { token: this.token },
          )
          .pipe(timeout(8_000)),
      );
      await this.session.ensureLoaded(true);
      this.accepted.set(true);
    } catch (error) {
      const response = error instanceof HttpErrorResponse ? error : undefined;
      this.error.set(
        response?.status === 403
          ? 'This invitation belongs to another email address. Sign in with the invited account and reopen the link.'
          : response?.status === 404 || response?.status === 410
            ? 'This invitation is no longer available. Ask the owner for a new link.'
            : 'The invitation could not be accepted. Check your connection and try again.',
      );
    } finally {
      this.pending.set(false);
    }
  }
}
