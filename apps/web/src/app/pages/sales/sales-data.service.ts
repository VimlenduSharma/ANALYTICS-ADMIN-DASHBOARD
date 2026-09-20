import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type {
  SalesExportJob,
  SalesFilterOptionsResponse,
  SalesFilters,
  SalesOrderDetail,
  SalesOrdersResponse,
  SalesOverviewResponse,
  SalesSort,
  SortDirection,
} from '@analytics-admin/contracts';
import type { Observable } from 'rxjs';

export interface SalesListQuery extends SalesFilters {
  cursor?: string;
  direction: SortDirection;
  pageSize: number;
  sort: SalesSort;
}

@Injectable()
export class SalesDataService {
  private readonly http = inject(HttpClient);

  overview(
    organizationId: string,
    query: SalesFilters | SalesListQuery,
  ): Observable<SalesOverviewResponse> {
    return this.http.get<SalesOverviewResponse>(
      this.base(organizationId, 'overview'),
      { params: parameters(salesFilters(query)) },
    );
  }

  orders(
    organizationId: string,
    query: SalesListQuery,
  ): Observable<SalesOrdersResponse> {
    return this.http.get<SalesOrdersResponse>(
      this.base(organizationId, 'orders'),
      { params: parameters(query) },
    );
  }

  order(organizationId: string, orderId: string): Observable<SalesOrderDetail> {
    return this.http.get<SalesOrderDetail>(
      this.base(organizationId, `orders/${orderId}`),
    );
  }

  options(organizationId: string): Observable<SalesFilterOptionsResponse> {
    return this.http.get<SalesFilterOptionsResponse>(
      this.base(organizationId, 'filter-options'),
    );
  }

  enqueueExport(
    organizationId: string,
    query: SalesListQuery,
    idempotencyKey: string,
  ): Observable<SalesExportJob> {
    return this.http.post<SalesExportJob>(
      this.base(organizationId, 'exports'),
      {
        ...salesFilters(query),
        direction: query.direction,
        sort: query.sort,
      },
      { headers: { 'Idempotency-Key': idempotencyKey } },
    );
  }

  exportStatus(
    organizationId: string,
    exportId: string,
  ): Observable<SalesExportJob> {
    return this.http.get<SalesExportJob>(
      this.base(organizationId, `exports/${exportId}`),
    );
  }

  exportDownloadUrl(organizationId: string, exportId: string): string {
    return this.base(organizationId, `exports/${exportId}/download`);
  }

  private base(organizationId: string, path: string): string {
    return `/api/v1/organizations/${organizationId}/sales/${path}`;
  }
}

function salesFilters(query: SalesFilters): SalesFilters {
  return {
    channelId: query.channelId,
    currency: query.currency,
    from: query.from,
    locationId: query.locationId,
    productId: query.productId,
    query: query.query,
    status: query.status,
    to: query.to,
  };
}

function parameters(values: object): HttpParams {
  return Object.entries(values).reduce(
    (params, [key, value]) =>
      value === undefined || value === ''
        ? params
        : params.set(key, String(value)),
    new HttpParams(),
  );
}
