import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ToastService } from './toast.service';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'aad-toast-region',
  template: `
    <aside class="toast-region" aria-label="Notifications" aria-live="polite">
      @for (toast of toasts.items(); track toast.id) {
        <section
          class="toast"
          [class]="'toast ' + toast.tone"
          [attr.role]="toast.tone === 'error' ? 'alert' : 'status'"
        >
          <span aria-hidden="true">
            {{
              toast.tone === 'success'
                ? '✓'
                : toast.tone === 'error'
                  ? '!'
                  : 'i'
            }}
          </span>
          <div>
            <strong>{{ toast.title }}</strong>
            <p>{{ toast.message }}</p>
          </div>
          <button
            type="button"
            (click)="toasts.dismiss(toast.id)"
            [attr.aria-label]="'Dismiss ' + toast.title + ' notification'"
          >
            ×
          </button>
        </section>
      }
    </aside>
  `,
  styles: `
    .toast-region {
      position: fixed;
      z-index: 90;
      right: 18px;
      bottom: 18px;
      display: grid;
      gap: 9px;
      width: min(390px, calc(100% - 36px));
      pointer-events: none;
    }
    .toast {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      gap: 11px;
      padding: 14px;
      border: 1px solid var(--border-strong);
      border-radius: 14px;
      background: var(--surface-raised);
      box-shadow: var(--shadow-strong);
      pointer-events: auto;
      animation: toast-in var(--motion-standard) var(--ease-out);
    }
    .toast > span {
      display: grid;
      place-items: center;
      width: 24px;
      height: 24px;
      border-radius: 8px;
      color: var(--surface-raised);
      background: var(--info);
      font-size: 0.72rem;
      font-weight: 850;
    }
    .toast.success > span {
      background: var(--success);
    }
    .toast.error > span {
      background: var(--danger);
    }
    strong {
      display: block;
      font-size: 0.78rem;
    }
    p {
      margin: 3px 0 0;
      color: var(--text-muted);
      font-size: 0.72rem;
      line-height: 1.45;
    }
    button {
      align-self: start;
      width: 30px;
      height: 30px;
      margin: -4px;
      border: 0;
      border-radius: 7px;
      color: var(--text-muted);
      background: transparent;
      cursor: pointer;
    }
    @keyframes toast-in {
      from {
        opacity: 0;
        transform: translateY(8px);
      }
    }
    @media (max-width: 760px) {
      .toast-region {
        right: 12px;
        bottom: 78px;
        width: calc(100% - 24px);
      }
    }
  `,
})
export class UiToastRegionComponent {
  protected readonly toasts = inject(ToastService);
}
