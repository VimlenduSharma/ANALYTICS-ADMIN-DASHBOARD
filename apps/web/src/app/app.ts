import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  HostListener,
  inject,
  signal,
} from '@angular/core';
import {
  NavigationEnd,
  Router,
  RouterLink,
  RouterLinkActive,
  RouterOutlet,
} from '@angular/router';
import { Meta, Title } from '@angular/platform-browser';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs';
import { SessionService } from './identity/session.service';
import { UiDialogComponent } from './shared/ui/ui-dialog';
import { UiToastRegionComponent } from './shared/ui/ui-toast-region';
import { ThemeService } from './theme.service';
import { AppearancePreferencesComponent } from './workspace/appearance-preferences';
import { CommandMenuComponent } from './workspace/command-menu';
import { WorkspaceFilterBarComponent } from './workspace/workspace-filter-bar';
import { WorkspaceFilterService } from './workspace/workspace-filter.service';
import {
  dateRangeForPreset,
  type DatePreset,
} from './workspace/workspace-preferences.service';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AppearancePreferencesComponent,
    CommandMenuComponent,
    RouterLink,
    RouterLinkActive,
    RouterOutlet,
    UiDialogComponent,
    UiToastRegionComponent,
    WorkspaceFilterBarComponent,
  ],
  selector: 'aad-root',
  styleUrl: './app.css',
  templateUrl: './app.html',
})
export class App {
  private readonly document = inject(DOCUMENT);
  private readonly meta = inject(Meta);
  private readonly router = inject(Router);
  private readonly title = inject(Title);
  protected readonly filters = inject(WorkspaceFilterService);
  protected readonly session = inject(SessionService);
  protected readonly theme = inject(ThemeService);
  protected readonly commandOpen = signal(false);
  protected readonly mobileMenuOpen = signal(false);
  protected readonly preferencesOpen = signal(false);
  protected readonly currentPath = signal(this.router.url);
  protected readonly moreSelected = computed(() =>
    ['/team', '/governance', '/workspace/components', '/profile'].some((path) =>
      this.currentPath().includes(path),
    ),
  );

  protected readonly selectedOrganization = computed(() =>
    this.session
      .organizations()
      .find(({ id }) => id === this.filters.organizationId()),
  );
  protected readonly canManageSelected = computed(() => {
    const role = this.selectedOrganization()?.role;
    return role === 'OWNER' || role === 'ADMIN';
  });
  protected readonly selectedTeamPath = computed(() => {
    const organization = this.selectedOrganization();
    return organization && this.canManageSelected()
      ? `/organizations/${organization.id}/team`
      : undefined;
  });
  protected readonly selectedGovernancePath = computed(() => {
    const organization = this.selectedOrganization();
    return organization && this.canManageSelected()
      ? `/organizations/${organization.id}/governance`
      : undefined;
  });
  protected readonly selectedSalesPath = computed(() => {
    const organization = this.selectedOrganization();
    return organization ? `/organizations/${organization.id}/sales` : undefined;
  });
  protected readonly selectedOperationsPath = computed(() => {
    const organization = this.selectedOrganization();
    return organization
      ? `/organizations/${organization.id}/operations`
      : undefined;
  });

  constructor() {
    effect(() => this.filters.syncOrganizations(this.session.organizations()));
    this.router.events
      .pipe(
        filter((event) => event instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(() => {
        this.currentPath.set(this.router.url);
        this.mobileMenuOpen.set(false);
        this.updatePageMetadata();
        queueMicrotask(() => {
          this.document.defaultView?.scrollTo({ left: 0, top: 0 });
          this.document
            .getElementById('main-content')
            ?.focus({ preventScroll: true });
        });
      });
    void this.session.ensureLoaded();
  }

  @HostListener('document:keydown', ['$event'])
  protected openCommandFromKeyboard(event: KeyboardEvent): void {
    if (!this.session.user() || event.key.toLowerCase() !== 'k') return;
    if (!event.metaKey && !event.ctrlKey) return;
    event.preventDefault();
    this.commandOpen.set(true);
  }

  protected selectOrganization(organizationId: string): void {
    const organizations = this.session.organizations();
    this.filters.setOrganization(organizationId, organizations);
    const analyticalView = ['/sales', '/operations'].find((path) =>
      this.router.url.includes(path),
    );
    if (analyticalView) {
      const tree = this.router.parseUrl(this.router.url);
      delete tree.queryParams['cursor'];
      delete tree.queryParams['orderId'];
      delete tree.queryParams['issueId'];
      void this.router.navigate(
        ['/organizations', organizationId, analyticalView.slice(1)],
        { queryParams: tree.queryParams },
      );
      return;
    }
    if (
      !this.router.url.includes('/team') &&
      !this.router.url.includes('/governance')
    )
      return;
    const selected = organizations.find(({ id }) => id === organizationId);
    const segment = this.router.url.includes('/governance')
      ? 'governance'
      : 'team';
    const path =
      selected?.role === 'OWNER' || selected?.role === 'ADMIN'
        ? `/organizations/${organizationId}/${segment}`
        : '/';
    void this.router.navigateByUrl(path);
  }

  protected selectDatePreset(preset: DatePreset): void {
    if (
      !this.router.url.includes('/sales') &&
      !this.router.url.includes('/operations')
    )
      return;
    const tree = this.router.parseUrl(this.router.url);
    Object.assign(tree.queryParams, dateRangeForPreset(preset));
    delete tree.queryParams['cursor'];
    delete tree.queryParams['orderId'];
    delete tree.queryParams['issueId'];
    void this.router.navigateByUrl(tree);
  }

  protected async signOut(): Promise<void> {
    await this.session.signOut();
  }

  protected openAppearanceFromMenu(): void {
    this.mobileMenuOpen.set(false);
    queueMicrotask(() => this.preferencesOpen.set(true));
  }

  private updatePageMetadata(): void {
    let route = this.router.routerState.snapshot.root;
    while (route.firstChild) route = route.firstChild;
    const { title, description } = route.data;
    if (typeof title === 'string') this.title.setTitle(title);
    if (typeof description === 'string')
      this.meta.updateTag({ name: 'description', content: description });
  }
}
