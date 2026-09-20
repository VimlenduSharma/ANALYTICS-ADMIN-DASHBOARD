import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { ActivatedRoute, ParamMap, Router } from '@angular/router';
import type {
  ApiError,
  OperationsAlert,
  OperationsFilters,
  OperationsIssue,
  OperationsIssuesResponse,
  OperationsIssueType,
  OperationsOverviewResponse,
  OperationsSeverity,
  OperationsThresholds,
} from '@analytics-admin/contracts';
import { firstValueFrom, forkJoin } from 'rxjs';
import { SessionService } from '../../identity/session.service';
import { UiBannerComponent } from '../../shared/ui/ui-banner';
import { UiDialogComponent } from '../../shared/ui/ui-dialog';
import { UiStatePanelComponent } from '../../shared/ui/ui-state-panel';
import { ToastService } from '../../shared/ui/toast.service';
import { WorkspaceFilterService } from '../../workspace/workspace-filter.service';
import { dateRangeForPreset } from '../../workspace/workspace-preferences.service';
import {
  OperationsDataService,
  type OperationsIssueQuery,
  type OperationsThresholdUpdate,
} from './operations-data.service';

type FilterOption<Value extends string> = { label: string; value: Value };

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    ReactiveFormsModule,
    UiBannerComponent,
    UiDialogComponent,
    UiStatePanelComponent,
  ],
  providers: [OperationsDataService],
  styleUrl: './operations.css',
  templateUrl: './operations.html',
})
export class OperationsPage {
  private readonly data = inject(OperationsDataService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly session = inject(SessionService);
  private readonly workspace = inject(WorkspaceFilterService);
  private readonly toasts = inject(ToastService);
  private requestVersion = 0;
  private loadedQuerySignature?: string;
  private issueTrigger: HTMLElement | null = null;

  protected readonly organizationId: string;
  protected readonly overview = signal<OperationsOverviewResponse | undefined>(
    undefined,
  );
  protected readonly issues = signal<OperationsIssuesResponse | undefined>(
    undefined,
  );
  protected readonly selectedIssue = signal<OperationsIssue | undefined>(
    undefined,
  );
  protected readonly loading = signal(true);
  protected readonly error = signal<string | undefined>(undefined);
  protected readonly settingsOpen = signal(false);
  protected readonly savingSettings = signal(false);
  protected readonly hasPreviousPage = signal(false);
  protected readonly organization = computed(() =>
    this.session.organizations().find(({ id }) => id === this.organizationId),
  );
  protected readonly canManage = computed(() =>
    ['OWNER', 'ADMIN'].includes(this.organization()?.role ?? ''),
  );
  protected readonly canOperate = computed(
    () => !!this.organization() && this.organization()?.role !== 'VIEWER',
  );
  protected readonly activeAlerts = computed(
    () =>
      this.overview()?.alerts.filter(({ status }) => status === 'active') ?? [],
  );
  protected readonly issueTypes: readonly FilterOption<OperationsIssueType>[] =
    [
      { label: 'Backlog', value: 'backlog' },
      { label: 'Late fulfilment', value: 'late-fulfilment' },
      { label: 'Low stock', value: 'low-stock' },
      { label: 'Cancellations', value: 'cancellation' },
      { label: 'Returns', value: 'return' },
    ];
  protected readonly severities: readonly FilterOption<OperationsSeverity>[] = [
    { label: 'Critical', value: 'critical' },
    { label: 'Warning', value: 'warning' },
    { label: 'Information', value: 'info' },
  ];
  protected readonly settings = new FormGroup({
    backlogCriticalMinutes: new FormControl(2_880, {
      nonNullable: true,
      validators: [
        Validators.required,
        Validators.min(120),
        Validators.max(86_400),
      ],
    }),
    backlogWarningMinutes: new FormControl(1_440, {
      nonNullable: true,
      validators: [
        Validators.required,
        Validators.min(60),
        Validators.max(43_200),
      ],
    }),
    cancellationWarningBasisPoints: new FormControl(1_000, {
      nonNullable: true,
      validators: [
        Validators.required,
        Validators.min(0),
        Validators.max(10_000),
      ],
    }),
    cutoffLocalTime: new FormControl('17:00', {
      nonNullable: true,
      validators: [
        Validators.required,
        Validators.pattern(/^([01]\d|2[0-3]):[0-5]\d$/),
      ],
    }),
    dataStaleAfterMinutes: new FormControl(1_440, {
      nonNullable: true,
      validators: [
        Validators.required,
        Validators.min(15),
        Validators.max(43_200),
      ],
    }),
    fulfilmentTargetMinutes: new FormControl(1_440, {
      nonNullable: true,
      validators: [
        Validators.required,
        Validators.min(60),
        Validators.max(10_080),
      ],
    }),
    lowStockBufferQuantity: new FormControl(0, {
      nonNullable: true,
      validators: [
        Validators.required,
        Validators.min(0),
        Validators.max(1_000_000_000),
      ],
    }),
    returnWarningBasisPoints: new FormControl(500, {
      nonNullable: true,
      validators: [
        Validators.required,
        Validators.min(0),
        Validators.max(10_000),
      ],
    }),
    timezone: new FormControl('UTC', {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(80)],
    }),
  });

  constructor() {
    const organizationId = this.route.snapshot.paramMap.get('organizationId');
    if (!organizationId) throw new Error('Operations route is incomplete');
    this.organizationId = organizationId;
    this.workspace.setOrganization(
      organizationId,
      this.session.organizations(),
    );
    this.route.queryParamMap
      .pipe(takeUntilDestroyed())
      .subscribe((params) => void this.synchronize(params));
  }

  protected applyFilter(name: keyof OperationsFilters, event: Event): void {
    void this.navigate({
      [name]: (event.target as HTMLSelectElement).value || null,
      cursor: null,
      issueId: null,
    });
  }

  protected clearFilters(): void {
    void this.navigate({
      cursor: null,
      issueId: null,
      issueType: null,
      locationId: null,
      severity: null,
    });
  }

  protected reviewAlert(alert: OperationsAlert): void {
    void this.navigate({ ...alert.query, cursor: null, issueId: null });
  }

  protected async toggleAlert(alert: OperationsAlert): Promise<void> {
    try {
      if (alert.status === 'active') {
        await firstValueFrom(
          this.data.acknowledge(
            this.organizationId,
            alert.key,
            this.currentFilters(),
          ),
        );
        this.toasts.success(
          'Alert acknowledged',
          'The issue remains visible until its source condition clears.',
        );
      } else {
        await firstValueFrom(this.data.reopen(this.organizationId, alert.key));
        this.toasts.info(
          'Alert reopened',
          'The alert is active for the operations team again.',
        );
      }
      await this.load(this.currentQuery());
    } catch (error) {
      this.toasts.error('Alert not updated', errorMessage(error));
    }
  }

  protected openSettings(): void {
    const thresholds = this.overview()?.thresholds;
    if (!thresholds) return;
    this.settings.setValue({
      ...withoutUpdatedAt(thresholds),
      lowStockBufferQuantity: Number(thresholds.lowStockBufferQuantity),
    });
    this.settingsOpen.set(true);
  }

  protected async saveSettings(): Promise<void> {
    this.settings.markAllAsTouched();
    const value = this.settings.getRawValue();
    if (
      this.settings.invalid ||
      value.backlogCriticalMinutes <= value.backlogWarningMinutes
    ) {
      this.toasts.error(
        'Thresholds need attention',
        'Check every value; critical backlog age must exceed warning age.',
      );
      return;
    }
    this.savingSettings.set(true);
    try {
      await firstValueFrom(
        this.data.updateThresholds(this.organizationId, value),
      );
      this.settingsOpen.set(false);
      this.toasts.success(
        'Thresholds saved',
        'New alerts now use the organization policy.',
      );
      await this.load(this.currentQuery());
    } catch (error) {
      this.toasts.error('Thresholds not saved', errorMessage(error));
    } finally {
      this.savingSettings.set(false);
    }
  }

  protected nextPage(): void {
    const cursor = this.issues()?.pageInfo.nextCursor;
    if (cursor) void this.navigate({ cursor, issueId: null });
  }

  protected previousPage(): void {
    globalThis.history.back();
  }

  protected openIssue(issue: OperationsIssue, event: Event): void {
    this.issueTrigger =
      event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    this.selectedIssue.set(issue);
    void this.navigate({ issueId: issue.id });
  }

  protected closeIssue(): void {
    const trigger = this.issueTrigger;
    this.selectedIssue.set(undefined);
    void this.navigate({ issueId: null }).then(() =>
      setTimeout(() => {
        if (trigger?.isConnected) trigger.focus();
      }, 0),
    );
  }

  protected retry(): void {
    void this.load(this.currentQuery());
  }

  protected duration(minutes: number | null | undefined): string {
    if (minutes === null || minutes === undefined)
      return 'No measured activity';
    const days = Math.floor(minutes / 1_440);
    const hours = Math.floor((minutes % 1_440) / 60);
    const remainder = minutes % 60;
    return (
      [
        days ? `${days}d` : '',
        hours ? `${hours}h` : '',
        remainder ? `${remainder}m` : '',
      ]
        .filter(Boolean)
        .join(' ') || '0m'
    );
  }

  protected percent(basisPoints: number | null): string {
    return basisPoints === null
      ? 'No eligible orders'
      : `${(basisPoints / 100).toFixed(1)}%`;
  }

  protected quantity(value: string): string {
    return BigInt(value).toLocaleString();
  }

  protected healthTitle(overview: OperationsOverviewResponse): string {
    return {
      delayed: 'Operational feeds are delayed',
      empty: 'No operational sources received',
      healthy: 'Operational sources are current',
      missing: 'Operational coverage is incomplete',
      partial: 'Operational data is still settling',
    }[overview.health.status];
  }

  protected healthMessage(overview: OperationsOverviewResponse): string {
    const affected = overview.health.sources
      .filter(({ status }) => status !== 'current')
      .map(({ source, status }) => `${source} ${status}`)
      .join(', ');
    return affected
      ? `${affected}. Healthy metrics are kept separate from missing or delayed source coverage.`
      : `All required sources are inside the ${this.duration(overview.thresholds.dataStaleAfterMinutes)} freshness policy.`;
  }

  private async synchronize(params: ParamMap): Promise<void> {
    const query = this.queryFrom(params);
    const issueId = params.get('issueId');
    this.hasPreviousPage.set(!!params.get('cursor'));
    if (querySignature(query) !== this.loadedQuerySignature) {
      await this.load(query);
    }
    if (issueId) {
      this.selectedIssue.set(
        this.issues()?.items.find(({ id }) => id === issueId),
      );
    } else {
      this.selectedIssue.set(undefined);
    }
  }

  private async load(query: OperationsIssueQuery): Promise<void> {
    const version = ++this.requestVersion;
    this.loading.set(true);
    this.error.set(undefined);
    try {
      const result = await firstValueFrom(
        forkJoin({
          issues: this.data.issues(this.organizationId, query),
          overview: this.data.overview(
            this.organizationId,
            issueFilters(query),
          ),
        }),
      );
      if (version !== this.requestVersion) return;
      this.issues.set(result.issues);
      this.overview.set(result.overview);
      this.loadedQuerySignature = querySignature(query);
    } catch (error) {
      if (version !== this.requestVersion) return;
      this.error.set(errorMessage(error));
    } finally {
      if (version === this.requestVersion) this.loading.set(false);
    }
  }

  private queryFrom(params: ParamMap): OperationsIssueQuery {
    const fallback = dateRangeForPreset(this.workspace.datePreset());
    return {
      from: params.get('from') ?? fallback.from,
      issueType: option(params, 'issueType', this.issueTypes),
      locationId: params.get('locationId') ?? undefined,
      severity: option(params, 'severity', this.severities),
      to: params.get('to') ?? fallback.to,
      cursor: params.get('cursor') ?? undefined,
      pageSize: 25,
    };
  }

  private currentQuery(): OperationsIssueQuery {
    return this.queryFrom(this.route.snapshot.queryParamMap);
  }

  private currentFilters(): OperationsFilters {
    return issueFilters(this.currentQuery());
  }

  private navigate(queryParams: Record<string, unknown>): Promise<boolean> {
    return this.router.navigate([], {
      queryParams,
      queryParamsHandling: 'merge',
      relativeTo: this.route,
    });
  }
}

function option<Value extends string>(
  params: ParamMap,
  key: string,
  options: readonly FilterOption<Value>[],
): Value | undefined {
  const value = params.get(key);
  return options.find((option) => option.value === value)?.value;
}

function issueFilters(query: OperationsIssueQuery): OperationsFilters {
  return {
    from: query.from,
    issueType: query.issueType,
    locationId: query.locationId,
    severity: query.severity,
    to: query.to,
  };
}

function querySignature(query: OperationsIssueQuery): string {
  return JSON.stringify(query);
}

function withoutUpdatedAt(thresholds: OperationsThresholds): Omit<
  OperationsThresholdUpdate,
  'lowStockBufferQuantity'
> & {
  lowStockBufferQuantity: string;
} {
  return {
    backlogCriticalMinutes: thresholds.backlogCriticalMinutes,
    backlogWarningMinutes: thresholds.backlogWarningMinutes,
    cancellationWarningBasisPoints: thresholds.cancellationWarningBasisPoints,
    cutoffLocalTime: thresholds.cutoffLocalTime,
    dataStaleAfterMinutes: thresholds.dataStaleAfterMinutes,
    fulfilmentTargetMinutes: thresholds.fulfilmentTargetMinutes,
    lowStockBufferQuantity: thresholds.lowStockBufferQuantity,
    returnWarningBasisPoints: thresholds.returnWarningBasisPoints,
    timezone: thresholds.timezone,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof HttpErrorResponse) {
    return (
      (error.error as Partial<ApiError> | undefined)?.message ??
      (error.status === 0
        ? 'The operations service could not be reached.'
        : `The operations request failed (${error.status}).`)
    );
  }
  return error instanceof Error
    ? error.message
    : 'An unexpected operations error occurred.';
}
