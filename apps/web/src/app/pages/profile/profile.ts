import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
} from '@angular/core';
import {
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { RouterLink } from '@angular/router';
import type { ApiError, UserProfile } from '@analytics-admin/contracts';
import { firstValueFrom } from 'rxjs';
import { SessionService } from '../../identity/session.service';
import { ToastService } from '../../shared/ui/toast.service';
import { UiFieldComponent } from '../../shared/ui/ui-field';
import { UiStatePanelComponent } from '../../shared/ui/ui-state-panel';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule,
    RouterLink,
    UiFieldComponent,
    UiStatePanelComponent,
  ],
  styleUrl: './profile.css',
  templateUrl: './profile.html',
})
export class ProfilePage {
  private readonly http = inject(HttpClient);
  private readonly session = inject(SessionService);
  private readonly toasts = inject(ToastService);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | undefined>(undefined);
  protected readonly email = signal('');
  protected readonly form = new FormGroup({
    displayName: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(120)],
    }),
    locale: new FormControl('en-US', {
      nonNullable: true,
      validators: [
        Validators.required,
        Validators.pattern(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/),
      ],
    }),
    timezone: new FormControl('UTC', {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(80)],
    }),
  });

  constructor() {
    void this.load();
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(undefined);
    try {
      const profile = await firstValueFrom(
        this.http.get<UserProfile>('/api/v1/profile'),
      );
      this.email.set(profile.email);
      this.form.setValue({
        displayName: profile.displayName,
        locale: profile.locale,
        timezone: profile.timezone,
      });
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.loading.set(false);
    }
  }

  protected async save(): Promise<void> {
    this.form.markAllAsTouched();
    if (this.form.invalid) return;
    this.saving.set(true);
    try {
      const profile = await firstValueFrom(
        this.http.patch<UserProfile>(
          '/api/v1/profile',
          this.form.getRawValue(),
        ),
      );
      this.form.setValue({
        displayName: profile.displayName,
        locale: profile.locale,
        timezone: profile.timezone,
      });
      await this.session.ensureLoaded(true);
      this.toasts.success(
        'Profile saved',
        'Your display and regional preferences are now current.',
      );
    } catch (error) {
      this.toasts.error('Profile not saved', errorMessage(error));
    } finally {
      this.saving.set(false);
    }
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof HttpErrorResponse) {
    const body = error.error as Partial<ApiError> | undefined;
    if (body?.message) return body.message;
  }
  return 'Your profile could not be loaded. Try again.';
}
