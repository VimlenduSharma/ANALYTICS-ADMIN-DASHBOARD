import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
} from '@angular/core';
import { FormControl, Validators } from '@angular/forms';
import { UiBannerComponent } from '../../shared/ui/ui-banner';
import { UiDialogComponent } from '../../shared/ui/ui-dialog';
import { UiFieldComponent } from '../../shared/ui/ui-field';
import { UiStatePanelComponent } from '../../shared/ui/ui-state-panel';
import { ToastService } from '../../shared/ui/toast.service';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    UiBannerComponent,
    UiDialogComponent,
    UiFieldComponent,
    UiStatePanelComponent,
  ],
  selector: 'aad-component-catalog-page',
  styleUrl: './component-catalog.css',
  templateUrl: './component-catalog.html',
})
export class ComponentCatalogPage {
  private readonly toasts = inject(ToastService);
  protected readonly dialogOpen = signal(false);
  protected readonly email = new FormControl('', {
    nonNullable: true,
    validators: [Validators.required, Validators.email],
  });

  protected validateField(): void {
    this.email.markAsTouched();
  }

  protected showToast(): void {
    this.toasts.success(
      'Preference saved',
      'The confirmation uses the same notification region as every workspace view.',
    );
  }
}
