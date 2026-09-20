import {
  ChangeDetectionStrategy,
  Component,
  effect,
  ElementRef,
  input,
  output,
  viewChild,
} from '@angular/core';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'aad-dialog',
  template: `
    <dialog
      #dialog
      [attr.aria-labelledby]="labelledBy()"
      [attr.aria-describedby]="describedBy() || null"
      (cancel)="cancel($event)"
      (pointerdown)="backdropClick($event)"
    >
      <section><ng-content /></section>
    </dialog>
  `,
  styles: `
    dialog {
      width: min(560px, calc(100% - 32px));
      max-height: min(760px, calc(100dvh - 32px));
      margin: auto;
      padding: 0;
      overflow: auto;
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-lg);
      color: var(--text);
      background: var(--surface-raised);
      box-shadow: 0 28px 100px rgba(0, 0, 0, 0.32);
      opacity: 0;
      transform: translateY(8px) scale(0.985);
      transition:
        opacity var(--motion-fast) var(--ease-standard),
        transform var(--motion-fast) var(--ease-standard),
        overlay var(--motion-fast) allow-discrete,
        display var(--motion-fast) allow-discrete;
    }
    dialog[open] {
      opacity: 1;
      transform: none;
    }
    @starting-style {
      dialog[open] {
        opacity: 0;
        transform: translateY(8px) scale(0.985);
      }
    }
    dialog::backdrop {
      background: rgba(5, 12, 11, 0.58);
    }
    section {
      min-width: 0;
    }
    @media (max-width: 560px) {
      dialog {
        width: calc(100% - 20px);
        max-height: calc(100dvh - 20px);
        border-radius: 18px;
      }
    }
  `,
})
export class UiDialogComponent {
  readonly describedBy = input('');
  readonly labelledBy = input.required<string>();
  readonly open = input(false);
  readonly dismissed = output<void>();
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');
  private returnFocus: HTMLElement | null = null;

  constructor() {
    effect(() => {
      const dialog = this.dialog()?.nativeElement;
      if (!dialog) return;
      if (this.open() && !dialog.open) {
        this.returnFocus =
          dialog.ownerDocument.activeElement instanceof HTMLElement
            ? dialog.ownerDocument.activeElement
            : null;
        if (typeof dialog.showModal === 'function') dialog.showModal();
        else dialog.setAttribute('open', '');
      }
      if (!this.open() && dialog.open) {
        if (typeof dialog.close === 'function') dialog.close();
        else dialog.removeAttribute('open');
        this.restoreFocus();
      }
    });
  }

  protected backdropClick(event: PointerEvent): void {
    if (event.target === this.dialog()?.nativeElement) this.dismissed.emit();
  }

  protected cancel(event: Event): void {
    event.preventDefault();
    this.dismissed.emit();
    this.restoreFocus();
  }

  private restoreFocus(): void {
    const target = this.returnFocus;
    this.returnFocus = null;
    setTimeout(() => {
      if (target?.isConnected) target.focus();
    }, 0);
  }
}
