import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
  output,
} from '@angular/core';
import type { OrganizationAccess } from '@analytics-admin/contracts';
import { WorkspaceFilterService } from './workspace-filter.service';
import { datePresets, type DatePreset } from './workspace-preferences.service';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'aad-workspace-filter-bar',
  template: `
    <section class="context-bar" aria-label="Workspace filters">
      <div class="context-label">
        <span aria-hidden="true"></span>
        <p>
          <strong>Live scope</strong><small>Applies across every view</small>
        </p>
      </div>

      <div class="filters">
        <label class="context-field">
          <span>Organization</span>
          <select
            aria-label="Organization filter"
            [value]="selectedOrganizationId() || ''"
            [disabled]="organizations().length === 0"
            (change)="changeOrganization($event)"
          >
            @if (!organizations().length) {
              <option value="">No organization</option>
            }
            @for (organization of organizations(); track organization.id) {
              <option
                [value]="organization.id"
                [selected]="organization.id === selectedOrganizationId()"
              >
                {{ organization.name }}
              </option>
            }
          </select>
        </label>

        <label class="context-field">
          <span>Date range</span>
          <select
            aria-label="Date range filter"
            [value]="filters.datePreset()"
            (change)="changeDate($event)"
          >
            @for (preset of presets; track preset.value) {
              <option
                [value]="preset.value"
                [selected]="preset.value === filters.datePreset()"
              >
                {{ preset.label }}
              </option>
            }
          </select>
        </label>
      </div>

      <p class="saved-note">Date preference saved on this device</p>
    </section>
  `,
  styles: `
    .context-bar {
      position: sticky;
      z-index: 15;
      top: 68px;
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      gap: 22px;
      min-height: 66px;
      padding: 9px clamp(16px, 3vw, 30px);
      border-bottom: 1px solid var(--border);
      background: var(--canvas);
    }
    .context-label,
    .filters,
    label,
    .saved-note {
      display: flex;
      align-items: center;
    }
    .context-label {
      gap: 10px;
    }
    .context-label > span {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--success);
      box-shadow: 0 0 0 4px var(--success-soft);
    }
    .context-label p {
      margin: 0;
    }
    .context-label strong,
    .context-label small {
      display: block;
    }
    .context-label strong {
      font-size: 0.72rem;
    }
    .context-label small {
      margin-top: 2px;
      color: var(--text-subtle);
      font-size: 0.62rem;
    }
    .filters {
      gap: 8px;
    }
    label {
      gap: 8px;
      min-height: 42px;
      padding: 0 8px 0 12px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: var(--surface-raised);
    }
    label > span {
      color: var(--text-subtle);
      font-size: 0.62rem;
      font-weight: 730;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    select {
      min-width: 142px;
      min-height: 32px;
      padding: 0 26px 0 8px;
      border: 0;
      color: var(--text);
      background: transparent;
      font-size: 0.73rem;
      font-weight: 680;
      cursor: pointer;
    }
    select:disabled {
      cursor: not-allowed;
      opacity: 0.6;
    }
    .saved-note {
      margin: 0;
      color: var(--text-subtle);
      font-size: 0.65rem;
      white-space: nowrap;
    }
    @media (max-width: 1040px) {
      .context-bar {
        grid-template-columns: 1fr auto;
      }
      .context-label,
      .saved-note {
        display: none;
      }
    }
    @media (max-width: 760px) {
      .context-bar {
        position: static;
        display: block;
        min-height: 0;
        padding: 10px 12px;
      }
      .filters {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      }
      label {
        display: grid;
        gap: 1px;
        min-width: 0;
        min-height: 48px;
        padding: 5px 8px;
      }
      select {
        width: 100%;
        min-width: 0;
        min-height: 27px;
        padding-left: 0;
      }
      .saved-note {
        display: none;
      }
    }
  `,
})
export class WorkspaceFilterBarComponent {
  readonly organizationSelected = output<string>();
  readonly dateSelected = output<DatePreset>();
  readonly organizations = input<readonly OrganizationAccess[]>([]);
  readonly selectedOrganizationId = input<string | undefined>();
  protected readonly filters = inject(WorkspaceFilterService);
  protected readonly presets = datePresets;

  protected changeDate(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.filters.setDatePreset(value);
    const preset = datePresets.find((item) => item.value === value)?.value;
    if (preset) this.dateSelected.emit(preset);
  }

  protected changeOrganization(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    if (value) this.organizationSelected.emit(value);
  }
}
