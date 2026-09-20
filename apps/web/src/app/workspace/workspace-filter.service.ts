import { computed, inject, Injectable, signal } from '@angular/core';
import type { OrganizationAccess } from '@analytics-admin/contracts';
import {
  datePresets,
  type DatePreset,
  WorkspacePreferencesService,
} from './workspace-preferences.service';

@Injectable({ providedIn: 'root' })
export class WorkspaceFilterService {
  private readonly preferences = inject(WorkspacePreferencesService);
  private readonly organizationIdSignal = signal<string | undefined>(undefined);

  readonly datePreset = this.preferences.datePreset;
  readonly dateLabel = computed(
    () =>
      datePresets.find(({ value }) => value === this.datePreset())?.label ??
      'Last 30 days',
  );
  readonly organizationId = this.organizationIdSignal.asReadonly();

  syncOrganizations(organizations: readonly OrganizationAccess[]): void {
    const current = this.organizationIdSignal();
    if (current && organizations.some(({ id }) => id === current)) return;
    this.organizationIdSignal.set(organizations[0]?.id);
  }

  setDatePreset(value: string): void {
    if (isDatePreset(value)) this.preferences.setDatePreset(value);
  }

  setOrganization(
    organizationId: string,
    organizations: readonly OrganizationAccess[],
  ): void {
    if (organizations.some(({ id }) => id === organizationId)) {
      this.organizationIdSignal.set(organizationId);
    }
  }
}

function isDatePreset(value: string): value is DatePreset {
  return datePresets.some((preset) => preset.value === value);
}
