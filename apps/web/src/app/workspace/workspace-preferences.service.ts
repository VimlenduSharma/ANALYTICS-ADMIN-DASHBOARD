import { DOCUMENT } from '@angular/common';
import { computed, inject, Injectable, signal } from '@angular/core';

export const datePresets = [
  { label: 'Last 7 days', value: 'last-7-days' },
  { label: 'Last 30 days', value: 'last-30-days' },
  { label: 'Quarter to date', value: 'quarter-to-date' },
  { label: 'Year to date', value: 'year-to-date' },
] as const;

export type DatePreset = (typeof datePresets)[number]['value'];
export type MotionPreference = 'system' | 'reduced';
export type Theme = 'light' | 'dark';

export function dateRangeForPreset(
  preset: DatePreset,
  now = new Date(),
): { from: string; to: string } {
  const tomorrow = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
  const start = new Date(tomorrow);
  if (preset === 'last-7-days' || preset === 'last-30-days') {
    start.setUTCDate(start.getUTCDate() - (preset === 'last-7-days' ? 7 : 30));
  } else if (preset === 'quarter-to-date') {
    start.setUTCMonth(Math.floor(now.getUTCMonth() / 3) * 3, 1);
  } else {
    start.setUTCMonth(0, 1);
  }
  return {
    from: start.toISOString().slice(0, 10),
    to: tomorrow.toISOString().slice(0, 10),
  };
}

interface WorkspacePreferences {
  datePreset: DatePreset;
  motion: MotionPreference;
  theme: Theme;
}

export const workspacePreferenceKey = 'aad-workspace-preferences-v1';

@Injectable({ providedIn: 'root' })
export class WorkspacePreferencesService {
  private readonly document = inject(DOCUMENT);
  private readonly value = signal<WorkspacePreferences>(this.read());

  readonly datePreset = computed(() => this.value().datePreset);
  readonly motion = computed(() => this.value().motion);
  readonly theme = computed(() => this.value().theme);

  constructor() {
    this.apply(this.value());
  }

  setDatePreset(datePreset: DatePreset): void {
    this.update({ datePreset });
  }

  setMotion(motion: MotionPreference): void {
    this.update({ motion });
  }

  setTheme(theme: Theme): void {
    this.update({ theme });
  }

  private update(change: Partial<WorkspacePreferences>): void {
    const next = { ...this.value(), ...change };
    this.value.set(next);
    this.apply(next);

    try {
      this.document.defaultView?.localStorage.setItem(
        workspacePreferenceKey,
        JSON.stringify(next),
      );
    } catch {
      // Device preferences remain usable when browser storage is unavailable.
    }
  }

  private read(): WorkspacePreferences {
    const fallback: WorkspacePreferences = {
      datePreset: 'last-30-days',
      motion: 'system',
      theme: this.systemTheme(),
    };

    try {
      const raw = this.document.defaultView?.localStorage.getItem(
        workspacePreferenceKey,
      );
      if (!raw) return fallback;
      const candidate = JSON.parse(raw) as Partial<WorkspacePreferences>;
      return {
        datePreset: isDatePreset(candidate.datePreset)
          ? candidate.datePreset
          : fallback.datePreset,
        motion: isMotion(candidate.motion) ? candidate.motion : fallback.motion,
        theme: isTheme(candidate.theme) ? candidate.theme : fallback.theme,
      };
    } catch {
      return fallback;
    }
  }

  private systemTheme(): Theme {
    return this.document.defaultView?.matchMedia?.(
      '(prefers-color-scheme: dark)',
    ).matches
      ? 'dark'
      : 'light';
  }

  private apply(preferences: WorkspacePreferences): void {
    const root = this.document.documentElement;
    root.dataset['theme'] = preferences.theme;
    root.style.colorScheme = preferences.theme;
    if (preferences.motion === 'reduced') root.dataset['motion'] = 'reduced';
    else delete root.dataset['motion'];
  }
}

function isDatePreset(value: unknown): value is DatePreset {
  return datePresets.some((preset) => preset.value === value);
}

function isMotion(value: unknown): value is MotionPreference {
  return value === 'system' || value === 'reduced';
}

function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark';
}
