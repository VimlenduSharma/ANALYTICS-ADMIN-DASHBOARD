import {
  HttpClient,
  HttpErrorResponse,
  HttpParams,
} from '@angular/common/http';
import { inject, Injectable, signal } from '@angular/core';
import type {
  ApiError,
  CreatedOrganizationInvitation,
  GovernanceAuditResponse,
  GovernanceJob,
  GovernanceJobType,
  GovernanceOverview,
  OrganizationGovernanceSettings,
  OrganizationRole,
} from '@analytics-admin/contracts';
import { firstValueFrom, forkJoin } from 'rxjs';

export interface OneTimeCredential {
  credentialRotatedAt?: string;
  id: string;
  name: string;
  path: string;
  secret: string;
  status: 'active' | 'revoked';
}

export type GovernanceState =
  | { kind: 'loading' }
  | {
      audit: GovernanceAuditResponse;
      kind: 'ready';
      overview: GovernanceOverview;
    }
  | { kind: 'error'; message: string };

@Injectable()
export class GovernanceDataService {
  private readonly http = inject(HttpClient);
  private readonly stateSignal = signal<GovernanceState>({ kind: 'loading' });
  readonly actionError = signal<string | undefined>(undefined);
  readonly state = this.stateSignal.asReadonly();

  async load(
    organizationId: string,
    auditFilters: { eventType?: string; from?: string; to?: string } = {},
  ): Promise<void> {
    this.stateSignal.set({ kind: 'loading' });
    try {
      let params = new HttpParams().set('pageSize', 25);
      for (const [key, value] of Object.entries(auditFilters)) {
        if (value) params = params.set(key, value);
      }
      const result = await firstValueFrom(
        forkJoin({
          audit: this.http.get<GovernanceAuditResponse>(
            `/api/v1/organizations/${organizationId}/governance/audit-events`,
            { params },
          ),
          overview: this.http.get<GovernanceOverview>(
            `/api/v1/organizations/${organizationId}/governance`,
          ),
        }),
      );
      this.stateSignal.set({ ...result, kind: 'ready' });
    } catch (error) {
      this.stateSignal.set({ kind: 'error', message: errorMessage(error) });
    }
  }

  createWebhook(
    organizationId: string,
    name: string,
  ): Promise<OneTimeCredential | undefined> {
    return this.action(() =>
      firstValueFrom(
        this.http.post<OneTimeCredential>(
          `/api/v1/organizations/${organizationId}/data/webhooks`,
          { name },
        ),
      ),
    );
  }

  rotateCredential(
    organizationId: string,
    sourceId: string,
  ): Promise<OneTimeCredential | undefined> {
    return this.action(() =>
      firstValueFrom(
        this.http.put<OneTimeCredential>(
          `/api/v1/organizations/${organizationId}/data/webhooks/${sourceId}/credential`,
          {},
        ),
      ),
    );
  }

  revokeWebhook(organizationId: string, sourceId: string): Promise<boolean> {
    return this.booleanAction(() =>
      firstValueFrom(
        this.http.delete(
          `/api/v1/organizations/${organizationId}/data/webhooks/${sourceId}`,
        ),
      ),
    );
  }

  invite(
    organizationId: string,
    request: {
      email: string;
      role: Exclude<OrganizationRole, 'OWNER'>;
    },
  ): Promise<CreatedOrganizationInvitation | undefined> {
    return this.action(() =>
      firstValueFrom(
        this.http.post<CreatedOrganizationInvitation>(
          `/api/v1/organizations/${organizationId}/governance/invitations`,
          request,
        ),
      ),
    );
  }

  revokeInvitation(
    organizationId: string,
    invitationId: string,
  ): Promise<boolean> {
    return this.booleanAction(() =>
      firstValueFrom(
        this.http.delete(
          `/api/v1/organizations/${organizationId}/governance/invitations/${invitationId}`,
        ),
      ),
    );
  }

  saveSettings(
    organizationId: string,
    settings: Omit<OrganizationGovernanceSettings, 'slug' | 'updatedAt'>,
  ): Promise<OrganizationGovernanceSettings | undefined> {
    return this.action(() =>
      firstValueFrom(
        this.http.patch<OrganizationGovernanceSettings>(
          `/api/v1/organizations/${organizationId}/governance/settings`,
          settings,
        ),
      ),
    );
  }

  enqueueJob(
    organizationId: string,
    type: GovernanceJobType,
    subjectExternalId?: string,
  ): Promise<GovernanceJob | undefined> {
    return this.action(() =>
      firstValueFrom(
        this.http.post<GovernanceJob>(
          `/api/v1/organizations/${organizationId}/governance/jobs`,
          { subjectExternalId: subjectExternalId || undefined, type },
          {
            headers: {
              'Idempotency-Key': `${type}-${crypto.randomUUID()}`,
            },
          },
        ),
      ),
    );
  }

  private async booleanAction(
    operation: () => Promise<unknown>,
  ): Promise<boolean> {
    return Boolean(
      await this.action(async () => {
        await operation();
        return true;
      }),
    );
  }

  private async action<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result | undefined> {
    this.actionError.set(undefined);
    try {
      return await operation();
    } catch (error) {
      this.actionError.set(errorMessage(error));
      return undefined;
    }
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof HttpErrorResponse) {
    const body = error.error as Partial<ApiError> | undefined;
    if (body?.message) return body.message;
    if (error.status === 403) return 'Your role does not permit this action.';
  }
  return 'The governance request could not be completed. Try again.';
}
