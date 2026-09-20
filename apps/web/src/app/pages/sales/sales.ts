import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  OnDestroy,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, ParamMap, Router } from '@angular/router';
import type {
  ApiError,
  SalesExportJob,
  SalesFilterOptionsResponse,
  SalesFilters,
  SalesOrderDetail,
  SalesOrdersResponse,
  SalesOverviewResponse,
  SalesSort,
} from '@analytics-admin/contracts';
import { firstValueFrom, forkJoin, timer } from 'rxjs';
import { SessionService } from '../../identity/session.service';
import { UiBannerComponent } from '../../shared/ui/ui-banner';
import { UiDialogComponent } from '../../shared/ui/ui-dialog';
import { UiStatePanelComponent } from '../../shared/ui/ui-state-panel';
import { ToastService } from '../../shared/ui/toast.service';
import { WorkspaceFilterService } from '../../workspace/workspace-filter.service';
import { dateRangeForPreset } from '../../workspace/workspace-preferences.service';
import { SalesDataService, type SalesListQuery } from './sales-data.service';
import { SalesTrendChartComponent } from './sales-trend-chart';

type SortOption = { label: string; value: SalesSort };

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    ReactiveFormsModule,
    SalesTrendChartComponent,
    UiBannerComponent,
    UiDialogComponent,
    UiStatePanelComponent,
  ],
  providers: [SalesDataService],
  styleUrl: './sales.css',
  templateUrl: './sales.html',
})
export class SalesPage implements OnDestroy {
  private readonly data = inject(SalesDataService);
  private readonly filters = inject(WorkspaceFilterService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly session = inject(SessionService);
  private readonly toasts = inject(ToastService);
  private requestVersion = 0;
  private destroyed = false;

  protected readonly organizationId: string;
  protected readonly search = new FormControl('', { nonNullable: true });
  protected readonly options = signal<SalesFilterOptionsResponse | undefined>(
    undefined,
  );
  protected readonly overview = signal<SalesOverviewResponse | undefined>(
    undefined,
  );
  protected readonly orders = signal<SalesOrdersResponse | undefined>(
    undefined,
  );
  protected readonly detail = signal<SalesOrderDetail | undefined>(undefined);
  protected readonly detailLoading = signal(false);
  protected readonly exportJob = signal<SalesExportJob | undefined>(undefined);
  protected readonly exporting = signal(false);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | undefined>(undefined);
  protected readonly organization = computed(() =>
    this.session.organizations().find(({ id }) => id === this.organizationId),
  );
  protected readonly sortOptions: readonly SortOption[] = [
    { label: 'Newest', value: 'occurredAt' },
    { label: 'Order number', value: 'orderNumber' },
    { label: 'Net revenue', value: 'revenue' },
    { label: 'Status', value: 'status' },
  ];

  constructor() {
    const organizationId = this.route.snapshot.paramMap.get('organizationId');
    if (!organizationId) throw new Error('Sales route is incomplete');
    this.organizationId = organizationId;
    this.filters.setOrganization(organizationId, this.session.organizations());
    this.route.queryParamMap
      .pipe(takeUntilDestroyed())
      .subscribe((params) => void this.synchronize(params));
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.requestVersion++;
  }

  protected applyFilter(name: keyof SalesFilters, event: Event): void {
    const value = (event.target as HTMLSelectElement).value || null;
    this.navigate({ [name]: value, cursor: null, orderId: null });
  }

  protected applySearch(): void {
    this.navigate({
      cursor: null,
      orderId: null,
      query: this.search.value.trim() || null,
    });
  }

  protected clearFilters(): void {
    this.navigate({
      channelId: null,
      cursor: null,
      locationId: null,
      orderId: null,
      productId: null,
      query: null,
      status: null,
    });
  }

  protected changeSort(event: Event): void {
    this.navigate({
      cursor: null,
      sort: (event.target as HTMLSelectElement).value,
    });
  }

  protected toggleDirection(): void {
    this.navigate({
      cursor: null,
      direction: this.currentQuery().direction === 'desc' ? 'asc' : 'desc',
    });
  }

  protected nextPage(): void {
    const cursor = this.orders()?.pageInfo.nextCursor;
    if (cursor) this.navigate({ cursor });
  }

  protected previousPage(): void {
    globalThis.history.back();
  }

  protected openOrder(orderId: string): void {
    this.navigate({ orderId });
  }

  protected closeOrder(): void {
    this.detailLoading.set(false);
    this.detail.set(undefined);
    this.navigate({ orderId: null });
  }

  protected async startExport(): Promise<void> {
    if (this.exporting()) return;
    this.exporting.set(true);
    try {
      let job = await firstValueFrom(
        this.data.enqueueExport(
          this.organizationId,
          this.currentQuery(),
          `sales-${crypto.randomUUID()}`,
        ),
      );
      this.exportJob.set(job);
      this.toasts.info(
        'Export queued',
        'Your current filtered order view is being prepared.',
      );
      for (
        let poll = 0;
        poll < 30 && ['queued', 'processing'].includes(job.status);
        poll += 1
      ) {
        await firstValueFrom(timer(1_000));
        job = await firstValueFrom(
          this.data.exportStatus(this.organizationId, job.id),
        );
        this.exportJob.set(job);
      }
      if (job.status === 'completed') {
        this.toasts.success(
          'Export ready',
          `${job.rowCount.toLocaleString()} filtered rows are ready to download.`,
        );
      } else if (job.status === 'failed') {
        this.toasts.error('Export failed', exportFailure(job.failureCode));
      }
    } catch (error) {
      this.toasts.error('Export unavailable', errorMessage(error));
    } finally {
      this.exporting.set(false);
    }
  }

  protected exportUrl(job: SalesExportJob): string {
    return this.data.exportDownloadUrl(this.organizationId, job.id);
  }

  protected money(value: string, currency = this.overview()?.currency): string {
    return currency
      ? new Intl.NumberFormat(undefined, {
          currency,
          style: 'currency',
        }).format(Number(value) / 100)
      : '—';
  }

  protected integer(value: string): string {
    return BigInt(value).toLocaleString();
  }

  protected comparison(basisPoints: number | null): string {
    if (basisPoints === null) return 'New vs previous period';
    if (basisPoints === 0) return 'No change vs previous period';
    const sign = basisPoints > 0 ? '+' : '';
    return `${sign}${(basisPoints / 100).toFixed(1)}% vs previous period`;
  }

  protected freshnessMessage(overview: SalesOverviewResponse): string {
    const freshness = overview.freshness;
    if (freshness.status === 'partial') {
      return `${freshness.pendingImportCount} import(s) processing and ${freshness.failedImportCount} recent failure(s). Displayed totals reflect committed records only.`;
    }
    return freshness.status === 'stale'
      ? 'No sales records have been updated in the last 24 hours. Verify the ingestion source.'
      : 'No source orders match the selected range and filters.';
  }

  protected retry(): void {
    void this.synchronize(this.route.snapshot.queryParamMap);
  }

  private async synchronize(params: ParamMap): Promise<void> {
    const version = ++this.requestVersion;
    this.loading.set(true);
    this.error.set(undefined);
    try {
      let options = this.options();
      if (!options) {
        options = await firstValueFrom(this.data.options(this.organizationId));
        if (version !== this.requestVersion) return;
        this.options.set(options);
      }
      const missingRange = !params.get('from') || !params.get('to');
      const missingCurrency =
        !params.get('currency') && options.currencies.length > 0;
      if (missingRange || missingCurrency) {
        const range = dateRangeForPreset(this.filters.datePreset());
        this.navigate(
          {
            currency: missingCurrency ? options.currencies[0] : undefined,
            from: missingRange ? range.from : undefined,
            to: missingRange ? range.to : undefined,
          },
          true,
        );
        return;
      }

      const query = queryFrom(params);
      this.search.setValue(query.query ?? '', { emitEvent: false });
      const orderId = params.get('orderId');
      const result = await firstValueFrom(
        forkJoin({
          orders: this.data.orders(this.organizationId, query),
          overview: this.data.overview(this.organizationId, query),
        }),
      );
      if (version !== this.requestVersion) return;
      this.overview.set(result.overview);
      this.orders.set(result.orders);
      if (orderId) await this.loadDetail(orderId, version);
      else this.detail.set(undefined);
    } catch (error) {
      if (version === this.requestVersion) this.error.set(errorMessage(error));
    } finally {
      if (version === this.requestVersion) this.loading.set(false);
    }
  }

  private async loadDetail(orderId: string, version: number): Promise<void> {
    this.detailLoading.set(true);
    try {
      const detail = await firstValueFrom(
        this.data.order(this.organizationId, orderId),
      );
      if (version === this.requestVersion) this.detail.set(detail);
    } catch (error) {
      if (version === this.requestVersion) {
        this.toasts.error('Order unavailable', errorMessage(error));
        this.navigate({ orderId: null }, true);
      }
    } finally {
      if (version === this.requestVersion) this.detailLoading.set(false);
    }
  }

  protected currentQuery(): SalesListQuery {
    return queryFrom(this.route.snapshot.queryParamMap);
  }

  private navigate(
    queryParams: Record<string, string | null | undefined>,
    replaceUrl = false,
  ): void {
    if (this.destroyed) return;
    void this.router.navigate([], {
      queryParams,
      queryParamsHandling: 'merge',
      replaceUrl,
      relativeTo: this.route,
    });
  }
}

function queryFrom(params: ParamMap): SalesListQuery {
  return compact({
    channelId: params.get('channelId') ?? undefined,
    currency: params.get('currency') ?? undefined,
    cursor: params.get('cursor') ?? undefined,
    direction: enumValue(params.get('direction'), ['asc', 'desc'], 'desc'),
    from: params.get('from') ?? '',
    locationId: params.get('locationId') ?? undefined,
    pageSize: 25,
    productId: params.get('productId') ?? undefined,
    query: params.get('query') ?? undefined,
    sort: enumValue(
      params.get('sort'),
      ['occurredAt', 'orderNumber', 'revenue', 'status'],
      'occurredAt',
    ),
    status: enumValue(
      params.get('status'),
      ['pending', 'confirmed', 'fulfilled', 'cancelled', 'refunded'],
      undefined,
    ),
    to: params.get('to') ?? '',
  }) as SalesListQuery;
}

function enumValue<
  const Values extends readonly string[],
  Fallback extends Values[number] | undefined,
>(
  value: string | null,
  values: Values,
  fallback: Fallback,
): Values[number] | Fallback {
  return value && values.includes(value) ? value : fallback;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}

function errorMessage(error: unknown): string {
  if (error instanceof HttpErrorResponse) {
    const body = error.error as Partial<ApiError> | undefined;
    if (body?.message) return body.message;
    if (error.status === 403)
      return 'Your organization role does not permit this request.';
  }
  return 'Sales analytics could not be loaded. Check the service and try again.';
}

function exportFailure(code?: string): string {
  return code === 'EXPORT_ROW_LIMIT'
    ? 'Narrow the filters before exporting; this request exceeded the safe row limit.'
    : 'The export could not be completed after bounded retries.';
}
