import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { SessionResponse } from '@analytics-admin/contracts';
import { App } from './app';

describe('App', () => {
  beforeEach(async () => {
    localStorage.clear();
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
      ],
    }).compileComponents();
  });

  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('keeps workspace navigation hidden before authentication', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    TestBed.inject(HttpTestingController)
      .expectOne('/api/v1/auth/session')
      .flush({
        authenticated: false,
        loginAvailable: true,
      } satisfies SessionResponse);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Analytics Admin');
    expect(fixture.nativeElement.querySelector('aside.sidebar')).toBeNull();
    expect(
      fixture.nativeElement.querySelector('.mobile-navigation'),
    ).toBeNull();
    expect(
      fixture.nativeElement.querySelector('aad-workspace-filter-bar'),
    ).toBeNull();
  });

  it('shows only authorized team navigation for an owner', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    TestBed.inject(HttpTestingController)
      .expectOne('/api/v1/auth/session')
      .flush({
        authenticated: true,
        csrfToken: 'csrf-token',
        organizations: [
          {
            id: 'b6c89418-151b-4f11-9415-e7fc2242ff1b',
            name: 'Northstar Operations',
            role: 'OWNER',
            slug: 'northstar-operations',
          },
        ],
        user: {
          displayName: 'Avery Morgan',
          email: 'avery@example.test',
          id: '9a4d28e6-8733-4910-9700-2c4e9addc805',
        },
      } satisfies SessionResponse);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Avery Morgan');
    expect(fixture.nativeElement.textContent).toContain('Team access');
  });
});
