import { Injectable, signal } from '@angular/core';

export type ToastTone = 'error' | 'info' | 'success';

export interface ToastMessage {
  id: number;
  message: string;
  title: string;
  tone: ToastTone;
}

@Injectable({ providedIn: 'root' })
export class ToastService {
  private nextId = 0;
  private readonly itemsSignal = signal<ToastMessage[]>([]);
  readonly items = this.itemsSignal.asReadonly();

  error(title: string, message: string): void {
    this.push(title, message, 'error', 7_000);
  }

  info(title: string, message: string): void {
    this.push(title, message, 'info', 5_000);
  }

  success(title: string, message: string): void {
    this.push(title, message, 'success', 5_000);
  }

  dismiss(id: number): void {
    this.itemsSignal.update((items) => items.filter((item) => item.id !== id));
  }

  private push(
    title: string,
    message: string,
    tone: ToastTone,
    duration: number,
  ): void {
    const toast = { id: ++this.nextId, message, title, tone };
    this.itemsSignal.update((items) => [...items.slice(-2), toast]);
    globalThis.setTimeout(() => this.dismiss(toast.id), duration);
  }
}
