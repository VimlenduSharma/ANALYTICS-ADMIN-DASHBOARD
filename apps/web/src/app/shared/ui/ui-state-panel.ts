import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';

export type InterfaceState =
  'empty' | 'error' | 'loading' | 'partial' | 'stale' | 'success';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'aad-state-panel',
  template: `
    <section
      class="state"
      [class]="'state ' + kind() + (compact() ? ' compact' : '')"
      [attr.role]="kind() === 'error' ? 'alert' : 'status'"
      [attr.aria-busy]="kind() === 'loading'"
    >
      <span class="state-mark" aria-hidden="true">
        @if (kind() === 'loading') {
          <i></i>
        } @else {
          {{ symbol() }}
        }
      </span>
      <div>
        <strong>{{ title() }}</strong>
        <p>{{ message() }}</p>
        @if (actionLabel()) {
          <button type="button" (click)="action.emit()">
            {{ actionLabel() }}
          </button>
        }
      </div>
    </section>
  `,
  styles: `
    .state {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      align-items: start;
      gap: 14px;
      min-height: 148px;
      padding: 24px;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: var(--surface);
    }
    .state.compact {
      min-height: 0;
      padding: 17px;
      border-radius: var(--radius-sm);
    }
    .state-mark {
      display: grid;
      place-items: center;
      width: 29px;
      height: 29px;
      border-radius: 9px;
      color: var(--accent-strong);
      background: var(--accent-soft);
      font-size: 0.78rem;
      font-weight: 850;
    }
    .state-mark i {
      width: 14px;
      height: 14px;
      border: 2px solid var(--border-strong);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    strong {
      display: block;
      margin-top: 3px;
      font-size: 0.84rem;
    }
    p {
      max-width: 54ch;
      margin: 6px 0 0;
      color: var(--text-muted);
      font-size: 0.75rem;
      line-height: 1.55;
    }
    button {
      min-height: 36px;
      margin-top: 13px;
      padding: 0 12px;
      border: 1px solid var(--border-strong);
      border-radius: 8px;
      color: var(--text);
      background: var(--surface-raised);
      font-size: 0.72rem;
      font-weight: 750;
      cursor: pointer;
    }
    .error .state-mark {
      color: var(--danger);
      background: var(--danger-soft);
    }
    .warning .state-mark,
    .stale .state-mark,
    .partial .state-mark {
      color: var(--warning-strong);
      background: var(--warning-soft);
    }
    .success .state-mark {
      color: var(--success);
      background: var(--success-soft);
    }
    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }
  `,
})
export class UiStatePanelComponent {
  readonly actionLabel = input('');
  readonly compact = input(false);
  readonly kind = input.required<InterfaceState>();
  readonly message = input.required<string>();
  readonly title = input.required<string>();
  readonly action = output<void>();

  protected readonly symbol = computed(
    () =>
      ({
        empty: '○',
        error: '!',
        loading: '',
        partial: '◐',
        stale: '↻',
        success: '✓',
      })[this.kind()],
  );
}
