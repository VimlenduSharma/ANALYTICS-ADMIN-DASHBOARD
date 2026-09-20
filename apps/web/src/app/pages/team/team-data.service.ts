import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { inject, Injectable, signal } from '@angular/core';
import type {
  AddTeamMemberRequest,
  ApiError,
  AuditEventSummary,
  TeamResponse,
  UpdateTeamMemberRequest,
} from '@analytics-admin/contracts';
import { firstValueFrom, forkJoin } from 'rxjs';

export type TeamDataState =
  | { kind: 'loading' }
  | {
      auditEvents: AuditEventSummary[];
      kind: 'ready';
      team: TeamResponse;
    }
  | { kind: 'error'; message: string };

@Injectable()
export class TeamDataService {
  private readonly http = inject(HttpClient);
  private readonly stateSignal = signal<TeamDataState>({ kind: 'loading' });
  readonly actionError = signal<string | undefined>(undefined);
  readonly state = this.stateSignal.asReadonly();

  async load(organizationId: string): Promise<void> {
    this.stateSignal.set({ kind: 'loading' });
    try {
      const result = await firstValueFrom(
        forkJoin({
          auditEvents: this.http.get<AuditEventSummary[]>(
            `/api/v1/organizations/${organizationId}/audit-events`,
          ),
          team: this.http.get<TeamResponse>(
            `/api/v1/organizations/${organizationId}/team`,
          ),
        }),
      );
      this.stateSignal.set({ ...result, kind: 'ready' });
    } catch (error) {
      this.stateSignal.set({ kind: 'error', message: errorMessage(error) });
    }
  }

  async addMember(
    organizationId: string,
    request: AddTeamMemberRequest,
  ): Promise<boolean> {
    return this.mutate(organizationId, () =>
      firstValueFrom(
        this.http.post(`/api/v1/organizations/${organizationId}/team`, request),
      ),
    );
  }

  async updateMember(
    organizationId: string,
    userId: string,
    request: UpdateTeamMemberRequest,
  ): Promise<boolean> {
    return this.mutate(organizationId, () =>
      firstValueFrom(
        this.http.patch(
          `/api/v1/organizations/${organizationId}/team/${userId}`,
          request,
        ),
      ),
    );
  }

  async removeMember(organizationId: string, userId: string): Promise<boolean> {
    return this.mutate(organizationId, () =>
      firstValueFrom(
        this.http.delete(
          `/api/v1/organizations/${organizationId}/team/${userId}`,
        ),
      ),
    );
  }

  private async mutate(
    organizationId: string,
    operation: () => Promise<unknown>,
  ): Promise<boolean> {
    this.actionError.set(undefined);
    try {
      await operation();
      await this.load(organizationId);
      return true;
    } catch (error) {
      this.actionError.set(errorMessage(error));
      return false;
    }
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof HttpErrorResponse) {
    const body = error.error as Partial<ApiError> | undefined;
    if (body?.message) return body.message;
    if (error.status === 403) return 'Your role does not permit this action.';
  }
  return 'The team request could not be completed. Try again.';
}
