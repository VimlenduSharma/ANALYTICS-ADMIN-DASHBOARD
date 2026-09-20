import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import {
  FormControl,
  type FormControlOptions,
  FormGroup,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import type {
  GovernanceDataSource,
  GovernanceJobType,
  OrganizationRole,
} from '@analytics-admin/contracts';
import { SessionService } from '../../identity/session.service';
import { ToastService } from '../../shared/ui/toast.service';
import { UiBannerComponent } from '../../shared/ui/ui-banner';
import { UiDialogComponent } from '../../shared/ui/ui-dialog';
import { UiFieldComponent } from '../../shared/ui/ui-field';
import { UiStatePanelComponent } from '../../shared/ui/ui-state-panel';
import { WorkspaceFilterService } from '../../workspace/workspace-filter.service';
import {
  GovernanceDataService,
  type OneTimeCredential,
} from './governance-data.service';

const ownerRoles: Exclude<OrganizationRole, 'OWNER'>[] = [
  'ADMIN',
  'ANALYST',
  'VIEWER',
];
const delegatedRoles: Exclude<OrganizationRole, 'OWNER'>[] = [
  'ANALYST',
  'VIEWER',
];

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    ReactiveFormsModule,
    RouterLink,
    UiBannerComponent,
    UiDialogComponent,
    UiFieldComponent,
    UiStatePanelComponent,
  ],
  providers: [GovernanceDataService],
  styleUrl: './governance.css',
  templateUrl: './governance.html',
})
export class GovernancePage {
  protected readonly data = inject(GovernanceDataService);
  private readonly route = inject(ActivatedRoute);
  private readonly session = inject(SessionService);
  private readonly toasts = inject(ToastService);
  private readonly workspace = inject(WorkspaceFilterService);

  protected readonly organizationId: string;
  protected readonly credential = signal<OneTimeCredential | undefined>(
    undefined,
  );
  protected readonly invitationPath = signal<string | undefined>(undefined);
  protected readonly deletionPending = signal(false);
  protected readonly saving = signal<string | undefined>(undefined);
  protected readonly organization = computed(() =>
    this.session.organizations().find(({ id }) => id === this.organizationId),
  );
  protected readonly isOwner = computed(
    () => this.organization()?.role === 'OWNER',
  );
  protected readonly invitationRoles = computed(() =>
    this.isOwner() ? ownerRoles : delegatedRoles,
  );
  protected readonly statusIsPending = (invitation: { status: string }) =>
    invitation.status === 'pending';

  protected readonly webhookForm = new FormGroup({
    name: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(120)],
    }),
  });
  protected readonly invitationForm = new FormGroup({
    email: new FormControl('', {
      nonNullable: true,
      validators: [
        Validators.required,
        Validators.email,
        Validators.maxLength(320),
      ],
    }),
    role: new FormControl<Exclude<OrganizationRole, 'OWNER'>>('VIEWER', {
      nonNullable: true,
      validators: [Validators.required],
    }),
  });
  protected readonly policyForm = new FormGroup({
    auditRetentionDays: new FormControl(730, bounded(30, 3_650)),
    exportRetentionHours: new FormControl(24, bounded(1, 168)),
    name: new FormControl('', {
      nonNullable: true,
      validators: [
        Validators.required,
        Validators.minLength(2),
        Validators.maxLength(100),
      ],
    }),
    operationalDataRetentionDays: new FormControl(730, bounded(30, 3_650)),
    privacyExportRetentionHours: new FormControl(24, bounded(1, 168)),
    reportingTimezone: new FormControl('UTC', {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(80)],
    }),
    weekStartsOn: new FormControl(1, bounded(0, 6)),
  });
  protected readonly privacyForm = new FormGroup({
    customerReference: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(160)],
    }),
  });
  protected readonly auditForm = new FormGroup({
    eventType: new FormControl('', { nonNullable: true }),
    from: new FormControl('', { nonNullable: true }),
    to: new FormControl('', { nonNullable: true }),
  });

  constructor() {
    const organizationId = this.route.snapshot.paramMap.get('organizationId');
    if (!organizationId) throw new Error('Governance route is incomplete');
    this.organizationId = organizationId;
    this.workspace.setOrganization(
      organizationId,
      this.session.organizations(),
    );
    void this.load();
  }

  protected async load(): Promise<void> {
    const filters = this.auditForm.getRawValue();
    await this.data.load(this.organizationId, {
      eventType: filters.eventType || undefined,
      from: filters.from ? new Date(filters.from).toISOString() : undefined,
      to: filters.to
        ? new Date(`${filters.to}T23:59:59.999Z`).toISOString()
        : undefined,
    });
    const state = this.data.state();
    if (state.kind !== 'ready') return;
    const settings = state.overview.settings;
    this.policyForm.setValue({
      auditRetentionDays: settings.auditRetentionDays,
      exportRetentionHours: settings.exportRetentionHours,
      name: settings.name,
      operationalDataRetentionDays: settings.operationalDataRetentionDays,
      privacyExportRetentionHours: settings.privacyExportRetentionHours,
      reportingTimezone: settings.reportingTimezone,
      weekStartsOn: settings.weekStartsOn,
    });
  }

  protected async createWebhook(): Promise<void> {
    if (this.webhookForm.invalid) return this.webhookForm.markAllAsTouched();
    this.saving.set('webhook');
    const result = await this.data.createWebhook(
      this.organizationId,
      this.webhookForm.controls.name.value,
    );
    this.saving.set(undefined);
    if (!result) return;
    this.webhookForm.reset({ name: '' });
    await this.load();
    this.credential.set(result);
    this.toasts.success(
      'Webhook connected',
      'Copy the signing secret now; it will not be shown again.',
    );
  }

  protected async rotate(source: GovernanceDataSource): Promise<void> {
    this.saving.set(source.id);
    const result = await this.data.rotateCredential(
      this.organizationId,
      source.id,
    );
    this.saving.set(undefined);
    if (!result) return;
    await this.load();
    this.credential.set(result);
    this.toasts.success(
      'Credential rotated',
      'The previous signing secret stopped working immediately.',
    );
  }

  protected async revokeSource(source: GovernanceDataSource): Promise<void> {
    this.saving.set(source.id);
    const revoked = await this.data.revokeWebhook(
      this.organizationId,
      source.id,
    );
    this.saving.set(undefined);
    if (!revoked) return;
    this.toasts.success('Source revoked', 'Inbound events are now rejected.');
    await this.load();
  }

  protected async invite(): Promise<void> {
    if (this.invitationForm.invalid) {
      return this.invitationForm.markAllAsTouched();
    }
    this.saving.set('invitation');
    const invitation = await this.data.invite(
      this.organizationId,
      this.invitationForm.getRawValue(),
    );
    this.saving.set(undefined);
    if (!invitation) return;
    this.invitationForm.reset({ email: '', role: 'VIEWER' });
    await this.load();
    this.invitationPath.set(
      new URL(invitation.acceptancePath, globalThis.location.origin).href,
    );
    this.toasts.success(
      'Invitation created',
      'Share the one-time acceptance link through your approved channel.',
    );
  }

  protected async revokeInvitation(invitationId: string): Promise<void> {
    this.saving.set(invitationId);
    const revoked = await this.data.revokeInvitation(
      this.organizationId,
      invitationId,
    );
    this.saving.set(undefined);
    if (revoked) await this.load();
  }

  protected async savePolicy(): Promise<void> {
    if (this.policyForm.invalid) return this.policyForm.markAllAsTouched();
    this.saving.set('policy');
    const result = await this.data.saveSettings(
      this.organizationId,
      this.policyForm.getRawValue(),
    );
    this.saving.set(undefined);
    if (!result) return;
    this.toasts.success(
      'Governance policy saved',
      'Retention and reporting boundaries are now active.',
    );
    await this.session.ensureLoaded(true);
    await this.load();
  }

  protected queuePrivacy(type: GovernanceJobType): void {
    if (this.privacyForm.invalid) {
      this.privacyForm.markAllAsTouched();
      return;
    }
    if (type === 'privacy-delete') {
      this.deletionPending.set(true);
      return;
    }
    void this.enqueue(type, this.privacyForm.controls.customerReference.value);
  }

  protected async confirmDeletion(): Promise<void> {
    this.deletionPending.set(false);
    await this.enqueue(
      'privacy-delete',
      this.privacyForm.controls.customerReference.value,
    );
  }

  protected runRetention(): void {
    void this.enqueue('retention');
  }

  protected applyAuditFilters(): void {
    void this.load();
  }

  protected clearAuditFilters(): void {
    this.auditForm.reset({ eventType: '', from: '', to: '' });
    void this.load();
  }

  protected statusLabel(status: string): string {
    return status.replace('-', ' ');
  }

  private async enqueue(
    type: GovernanceJobType,
    subjectExternalId?: string,
  ): Promise<void> {
    this.saving.set(type);
    const job = await this.data.enqueueJob(
      this.organizationId,
      type,
      subjectExternalId,
    );
    this.saving.set(undefined);
    if (!job) return;
    this.toasts.info(
      'Workflow queued',
      'Progress is durable and can resume after a worker interruption.',
    );
    await this.load();
  }
}

function bounded(
  min: number,
  max: number,
): FormControlOptions & { nonNullable: true } {
  return {
    nonNullable: true,
    validators: [Validators.required, Validators.min(min), Validators.max(max)],
  };
}
