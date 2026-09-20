import { TestBed } from '@angular/core/testing';
import { FormControl, Validators } from '@angular/forms';
import { UiFieldComponent } from './ui-field';

describe('UiFieldComponent', () => {
  it('reflects control validation changes in accessible attributes', () => {
    const control = new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.email],
    });
    const fixture = TestBed.createComponent(UiFieldComponent);
    fixture.componentRef.setInput('control', control);
    fixture.componentRef.setInput('fieldId', 'work-email');
    fixture.componentRef.setInput('label', 'Work email');
    fixture.componentRef.setInput('hint', 'Use your company address.');
    fixture.componentRef.setInput('errorText', 'Enter a valid email.');
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector(
      'input',
    ) as HTMLInputElement;
    expect(input.getAttribute('aria-invalid')).toBe('false');
    expect(input.getAttribute('aria-describedby')).toBe('work-email-hint');

    control.setValue('not-an-email');
    control.markAsTouched();
    fixture.detectChanges();

    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe('work-email-error');
    expect(fixture.nativeElement.textContent).toContain('Enter a valid email.');
  });
});
