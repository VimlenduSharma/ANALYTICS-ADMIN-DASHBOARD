import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type {
  OperationsFilters,
  OperationsIssuesResponse,
  OperationsOverviewResponse,
  OperationsThresholds,
} from '@analytics-admin/contracts';
import type { Observable } from 'rxjs';

export interface OperationsIssueQuery extends OperationsFilters {
  cursor?: string;
  pageSize: number;
}

export type OperationsThresholdUpdate = Omit<
  OperationsThresholds,
  'lowStockBufferQuantity' | 'updatedAt'
> & { lowStockBufferQuantity: number };

@Injectable()
export class OperationsDataService {
  private readonly http = inject(HttpClient);

  overview(
    organizationId: string,
    filters: OperationsFilters,
  ): Observable<OperationsOverviewResponse> {
    return this.http.get<OperationsOverviewResponse>(
      this.base(organizationId, 'overview'),
      { params: parameters(filters) },
    );
  }

  issues(
    organizationId: string,
    query: OperationsIssueQuery,
  ): Observable<OperationsIssuesResponse> {
    return this.http.get<OperationsIssuesResponse>(
      this.base(organizationId, 'issues'),
      { params: parameters(query) },
    );
  }

  updateThresholds(
    organizationId: string,
    thresholds: OperationsThresholdUpdate,
  ): Observable<OperationsThresholds> {
    return this.http.patch<OperationsThresholds>(
      this.base(organizationId, 'thresholds'),
      thresholds,
    );
  }

  acknowledge(
    organizationId: string,
    alertKey: string,
    filters: OperationsFilters,
  ): Observable<void> {
    return this.http.post<void>(
      this.base(
        organizationId,
        `alerts/${encodeURIComponent(alertKey)}/acknowledgement`,
      ),
      null,
      { params: parameters(filters) },
    );
  }

  reopen(organizationId: string, alertKey: string): Observable<void> {
    return this.http.delete<void>(
      this.base(
        organizationId,
        `alerts/${encodeURIComponent(alertKey)}/acknowledgement`,
      ),
    );
  }

  private base(organizationId: string, path: string): string {
    return `/api/v1/organizations/${organizationId}/operations/${path}`;
  }
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
