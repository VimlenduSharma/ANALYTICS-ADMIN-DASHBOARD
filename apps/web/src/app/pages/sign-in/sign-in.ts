import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { SessionService } from '../../identity/session.service';

const errorMessages: Record<string, string> = {
  identity_callback_failed:
    'The identity provider response could not be verified. No session was created. Start a new sign-in attempt.',
  provider_unavailable:
    'Sign-in is not configured for this environment. Ask an administrator to connect an OpenID Connect provider.',
  session_expired:
    'Your session has expired or was revoked. Sign in again to continue.',
};

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  styleUrl: './sign-in.css',
  templateUrl: './sign-in.html',
})
export class SignInPage {
  protected readonly session = inject(SessionService);
  private readonly route = inject(ActivatedRoute);
  protected readonly invitationRequiresSignIn = computed(
    () => this.route.snapshot.queryParamMap.get('invitation') === 'reopen',
  );
  protected readonly errorMessage = computed(() => {
    const code = this.route.snapshot.queryParamMap.get('error') ?? '';
    return errorMessages[code];
  });
  protected readonly loginUrl = computed(() => {
    const requested = this.route.snapshot.queryParamMap.get('returnTo');
    const returnTo =
      requested?.startsWith('/') && !requested.startsWith('//')
        ? requested
        : '/';
    return `/api/v1/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
  });
}
