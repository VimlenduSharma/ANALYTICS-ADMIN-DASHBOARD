import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';

export type BannerTone = 'error' | 'info' | 'success' | 'warning';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'aad-banner',
  template: `
    <section
      class="banner"
      [class]="'banner ' + tone()"
      [attr.role]="role()"
      [attr.aria-live]="role() === 'alert' ? 'assertive' : 'polite'"
    >
      <span class="mark" aria-hidden="true">{{ symbol() }}</span>
      <div>
        <strong>{{ title() }}</strong>
        <p><ng-content /></p>
      </div>
      @if (dismissible()) {
        <button type="button" (click)="dismissed.emit()" aria-label="Dismiss">
          ×
        </button>
      }
    </section>
  `,
  styles: `
    .banner {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: start;
      gap: 11px;
      padding: 13px 14px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text);
      background: var(--surface-muted);
    }
    .mark {
      display: grid;
      place-items: center;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      color: var(--surface-raised);
      background: var(--info);
      font-size: 0.71rem;
      font-weight: 850;
    }
    strong {
      display: block;
      font-size: 0.77rem;
    }
    p {
      margin: 3px 0 0;
      color: var(--text-muted);
      font-size: 0.73rem;
      line-height: 1.5;
    }
    button {
      width: 30px;
      height: 30px;
      margin: -4px;
      border: 0;
      border-radius: 7px;
      color: var(--text-muted);
      background: transparent;
      cursor: pointer;
    }
    button:hover {
      color: var(--text);
      background: color-mix(in srgb, var(--text) 7%, transparent);
    }
    .success {
      border-color: color-mix(in srgb, var(--success) 35%, var(--border));
      background: var(--success-soft);
    }
    .success .mark {
      background: var(--success);
    }
    .warning {
      border-color: color-mix(in srgb, var(--warning) 38%, var(--border));
      background: var(--warning-soft);
    }
    .warning .mark {
      color: var(--canvas);
      background: var(--warning);
    }
    .error {
      border-color: color-mix(in srgb, var(--danger) 36%, var(--border));
      background: var(--danger-soft);
    }
    .error .mark {
      background: var(--danger);
    }
  `,
})
export class UiBannerComponent {
  readonly dismissible = input(false);
  readonly title = input.required<string>();
  readonly tone = input<BannerTone>('info');
  readonly dismissed = output<void>();

  protected readonly role = computed(() =>
    this.tone() === 'error' ? 'alert' : 'status',
  );
  protected readonly symbol = computed(
    () => ({ error: '!', info: 'i', success: '✓', warning: '!' })[this.tone()],
  );
}
