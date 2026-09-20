import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  input,
  output,
} from '@angular/core';
import { WorkspacePreferencesService } from './workspace-preferences.service';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'aad-appearance-preferences',
  template: `
    <div class="preferences-panel">
      <header>
        <div>
          <p class="eyebrow">Device preferences</p>
          <h2 [id]="headingId()">Make the workspace yours</h2>
          <p [id]="descriptionId()">
            These display choices stay on this device. Account and organization
            data never do.
          </p>
        </div>
        <button
          data-preferences-focus
          type="button"
          class="dialog-close"
          aria-label="Close appearance preferences"
          (click)="closed.emit()"
        >
          ×
        </button>
      </header>

      <fieldset>
        <legend>Color theme</legend>
        <label [class.is-selected]="preferences.theme() === 'light'">
          <input
            type="radio"
            [name]="groupName() + '-theme'"
            value="light"
            [checked]="preferences.theme() === 'light'"
            (change)="preferences.setTheme('light')"
          />
          <span
            ><strong>Light</strong><small>Warm, focused surfaces</small></span
          >
        </label>
        <label [class.is-selected]="preferences.theme() === 'dark'">
          <input
            type="radio"
            [name]="groupName() + '-theme'"
            value="dark"
            [checked]="preferences.theme() === 'dark'"
            (change)="preferences.setTheme('dark')"
          />
          <span
            ><strong>Dark</strong
            ><small>Low-glare operational view</small></span
          >
        </label>
      </fieldset>

      <fieldset>
        <legend>Motion</legend>
        <label [class.is-selected]="preferences.motion() === 'system'">
          <input
            type="radio"
            [name]="groupName() + '-motion'"
            value="system"
            [checked]="preferences.motion() === 'system'"
            (change)="preferences.setMotion('system')"
          />
          <span
            ><strong>Follow system</strong
            ><small>Use your operating-system setting</small></span
          >
        </label>
        <label [class.is-selected]="preferences.motion() === 'reduced'">
          <input
            type="radio"
            [name]="groupName() + '-motion'"
            value="reduced"
            [checked]="preferences.motion() === 'reduced'"
            (change)="preferences.setMotion('reduced')"
          />
          <span
            ><strong>Reduce motion</strong
            ><small>Minimize transitions and movement</small></span
          >
        </label>
      </fieldset>
    </div>
  `,
  styles: `
    .preferences-panel {
      padding: 22px;
    }
    header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 18px;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--border);
    }
    .eyebrow {
      margin: 0 0 7px;
      color: var(--accent-strong);
      font-size: 0.64rem;
      font-weight: 780;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    h2 {
      margin: 0;
      font-size: 1.3rem;
      letter-spacing: -0.035em;
    }
    header p:last-child {
      max-width: 45ch;
      margin: 7px 0 0;
      color: var(--text-muted);
      font-size: 0.76rem;
      line-height: 1.55;
    }
    .dialog-close {
      width: 34px;
      height: 34px;
      border: 1px solid var(--border);
      border-radius: 9px;
      color: var(--text-muted);
      background: var(--surface-muted);
      font-size: 1.2rem;
      cursor: pointer;
    }
    fieldset {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 9px;
      margin: 20px 0 0;
      padding: 0;
      border: 0;
    }
    legend {
      grid-column: 1 / -1;
      margin-bottom: 2px;
      font-size: 0.72rem;
      font-weight: 760;
    }
    label {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 9px;
      padding: 12px;
      border: 1px solid var(--border);
      border-radius: 11px;
      cursor: pointer;
    }
    label.is-selected {
      border-color: var(--accent);
      background: var(--accent-soft);
    }
    input {
      margin-top: 3px;
      accent-color: var(--accent-strong);
    }
    strong,
    small {
      display: block;
    }
    strong {
      font-size: 0.74rem;
    }
    small {
      margin-top: 3px;
      color: var(--text-muted);
      font-size: 0.65rem;
      line-height: 1.4;
    }
    @media (max-width: 480px) {
      .preferences-panel {
        padding: 17px;
      }
      fieldset {
        grid-template-columns: 1fr;
      }
    }
  `,
})
export class AppearancePreferencesComponent implements AfterViewInit {
  readonly autoFocus = input(false);
  readonly closed = output<void>();
  readonly descriptionId = input.required<string>();
  readonly groupName = input.required<string>();
  readonly headingId = input.required<string>();
  protected readonly preferences = inject(WorkspacePreferencesService);
  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);

  ngAfterViewInit(): void {
    if (!this.autoFocus()) return;
    queueMicrotask(() =>
      this.host.nativeElement
        .querySelector<HTMLElement>('[data-preferences-focus]')
        ?.focus(),
    );
  }
}
