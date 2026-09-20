import { HttpClient } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormControl, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import type { OrganizationAccess } from '@analytics-admin/contracts';
import { firstValueFrom } from 'rxjs';
import { HealthService } from '../../health.service';
import { SessionService } from '../../identity/session.service';
import { UiBannerComponent } from '../../shared/ui/ui-banner';
import { UiFieldComponent } from '../../shared/ui/ui-field';
import { UiStatePanelComponent } from '../../shared/ui/ui-state-panel';
import { ToastService } from '../../shared/ui/toast.service';
import { WorkspaceFilterService } from '../../workspace/workspace-filter.service';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    UiBannerComponent,
    UiFieldComponent,
    UiStatePanelComponent,
  ],
  styleUrl: './home.css',
  templateUrl: './home.html',
})
export class HomePage {
  private readonly filters = inject(WorkspaceFilterService);
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  protected readonly creating = signal(false);
  protected readonly creationError = signal<string | undefined>(undefined);
  protected readonly dateLabel = this.filters.dateLabel;
  protected readonly health = inject(HealthService);
  protected readonly organizationName = new FormControl('', {
    nonNullable: true,
    validators: [
      Validators.required,
      Validators.minLength(2),
      Validators.maxLength(100),
    ],
  });
  protected readonly session = inject(SessionService);
  protected readonly selectedOrganization = computed(() =>
    this.session
      .organizations()
      .find(({ id }) => id === this.filters.organizationId()),
  );

  protected selectOrganization(organizationId: string): void {
    this.filters.setOrganization(organizationId, this.session.organizations());
  }

  protected async createOrganization(): Promise<void> {
    if (this.organizationName.invalid || this.creating()) {
      this.organizationName.markAsTouched();
      return;
    }

    this.creating.set(true);
    this.creationError.set(undefined);
    try {
      const organization = await firstValueFrom(
        this.http.post<OrganizationAccess>('/api/v1/organizations', {
          name: this.organizationName.value.trim(),
        }),
      );
      await this.session.ensureLoaded(true);
      this.selectOrganization(organization.id);
      this.toasts.success(
        'Workspace created',
        'Your organization is selected and ready for team access.',
      );
      await this.router.navigate(['/organizations', organization.id, 'team']);
    } catch {
      this.creationError.set(
        'The organization could not be created. Check the name and try again.',
      );
    } finally {
      this.creating.set(false);
    }
  }
}
