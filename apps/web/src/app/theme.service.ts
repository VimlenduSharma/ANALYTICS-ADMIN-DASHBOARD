import { inject, Injectable } from '@angular/core';
import {
  type Theme,
  WorkspacePreferencesService,
} from './workspace/workspace-preferences.service';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly preferences = inject(WorkspacePreferencesService);
  readonly theme = this.preferences.theme;

  toggle(): void {
    this.set(this.theme() === 'light' ? 'dark' : 'light');
  }

  set(theme: Theme): void {
    this.preferences.setTheme(theme);
  }
}
