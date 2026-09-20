import { TestBed } from '@angular/core/testing';
import {
  dateRangeForPreset,
  workspacePreferenceKey,
  WorkspacePreferencesService,
} from './workspace-preferences.service';

describe('WorkspacePreferencesService', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-motion');
    document.documentElement.removeAttribute('data-theme');
    TestBed.configureTestingModule({});
  });

  it('persists only allowlisted display preferences', () => {
    const preferences = TestBed.inject(WorkspacePreferencesService);

    preferences.setTheme('dark');
    preferences.setMotion('reduced');
    preferences.setDatePreset('quarter-to-date');

    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(document.documentElement.dataset['motion']).toBe('reduced');
    expect(
      JSON.parse(localStorage.getItem(workspacePreferenceKey) ?? '{}'),
    ).toEqual({
      datePreset: 'quarter-to-date',
      motion: 'reduced',
      theme: 'dark',
    });
  });

  it('ignores unknown fields when restoring preferences', () => {
    localStorage.setItem(
      workspacePreferenceKey,
      JSON.stringify({
        datePreset: 'last-7-days',
        motion: 'reduced',
        organizationId: 'private-tenant-id',
        query: 'private search',
        theme: 'dark',
      }),
    );

    const preferences = TestBed.inject(WorkspacePreferencesService);
    preferences.setDatePreset('year-to-date');
    const stored = JSON.parse(
      localStorage.getItem(workspacePreferenceKey) ?? '{}',
    ) as Record<string, unknown>;

    expect(preferences.theme()).toBe('dark');
    expect(preferences.motion()).toBe('reduced');
    expect(Object.keys(stored).sort()).toEqual([
      'datePreset',
      'motion',
      'theme',
    ]);
    expect(JSON.stringify(stored)).not.toContain('private');
  });

  it('turns saved presets into exclusive UTC reporting ranges', () => {
    const now = new Date('2026-09-09T14:30:00+05:30');

    expect(dateRangeForPreset('last-7-days', now)).toEqual({
      from: '2026-09-03',
      to: '2026-09-10',
    });
    expect(dateRangeForPreset('quarter-to-date', now)).toEqual({
      from: '2026-07-01',
      to: '2026-09-10',
    });
    expect(dateRangeForPreset('year-to-date', now)).toEqual({
      from: '2026-01-01',
      to: '2026-09-10',
    });
  });
});
