import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule],
  selector: 'aad-field',
  template: `
    <div class="field" [class.has-error]="showError()">
      <label [for]="fieldId()">
        {{ label() }}
        @if (required()) {
          <span aria-hidden="true">Required</span>
        }
      </label>
      <input
        [id]="fieldId()"
        [type]="type()"
        [autocomplete]="autocomplete()"
        [placeholder]="placeholder()"
        [attr.maxlength]="maxLength()"
        [attr.aria-describedby]="describedBy()"
        [attr.aria-invalid]="showError()"
        [attr.aria-required]="required()"
        [formControl]="control()"
      />
      @if (showError()) {
        <small [id]="errorId()">{{ errorText() }}</small>
      } @else if (hint()) {
        <small class="hint" [id]="hintId()">{{ hint() }}</small>
      }
    </div>
  `,
  styles: `
    .field {
      display: grid;
      gap: 7px;
    }
    label {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      color: var(--text);
      font-size: 0.76rem;
      font-weight: 720;
    }
    label span {
      color: var(--text-subtle);
      font-size: 0.63rem;
      font-weight: 650;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    input {
      width: 100%;
      min-width: 0;
      min-height: 44px;
      padding: 0 12px;
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-sm);
      color: var(--text);
      background: var(--surface-raised);
      box-shadow: inset 0 1px 0 color-mix(in srgb, white 45%, transparent);
    }
    input::placeholder {
      color: var(--text-subtle);
    }
    input:hover:not(:disabled) {
      border-color: var(--text-subtle);
    }
    input:disabled {
      cursor: not-allowed;
      opacity: 0.58;
    }
    .has-error input {
      border-color: var(--danger);
    }
    small {
      color: var(--danger);
      font-size: 0.69rem;
      line-height: 1.45;
    }
    small.hint {
      color: var(--text-muted);
    }
  `,
})
export class UiFieldComponent {
  readonly autocomplete = input('off');
  readonly control = input.required<FormControl<string>>();
  readonly errorText = input('Check this value and try again.');
  readonly fieldId = input.required<string>();
  readonly hint = input('');
  readonly label = input.required<string>();
  readonly maxLength = input<number | undefined>(undefined);
  readonly placeholder = input('');
  readonly required = input(false);
  readonly type = input<'email' | 'search' | 'text'>('text');

  protected readonly errorId = computed(() => `${this.fieldId()}-error`);
  protected readonly hintId = computed(() => `${this.fieldId()}-hint`);
  protected showError(): boolean {
    return this.control().touched && this.control().invalid;
  }

  protected describedBy(): string | null {
    if (this.showError()) return this.errorId();
    return this.hint() ? this.hintId() : null;
  }
}
