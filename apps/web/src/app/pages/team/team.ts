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
  FormGroup,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import type { OrganizationRole, TeamMember } from '@analytics-admin/contracts';
import { SessionService } from '../../identity/session.service';
import { UiBannerComponent } from '../../shared/ui/ui-banner';
import { UiDialogComponent } from '../../shared/ui/ui-dialog';
import { UiFieldComponent } from '../../shared/ui/ui-field';
import { UiStatePanelComponent } from '../../shared/ui/ui-state-panel';
import { ToastService } from '../../shared/ui/toast.service';
import { WorkspaceFilterService } from '../../workspace/workspace-filter.service';
import { TeamDataService } from './team-data.service';

const allRoles: OrganizationRole[] = ['OWNER', 'ADMIN', 'ANALYST', 'VIEWER'];
const delegatedRoles: OrganizationRole[] = ['ANALYST', 'VIEWER'];

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
  providers: [TeamDataService],
  styleUrl: './team.css',
  templateUrl: './team.html',
})
export class TeamPage {
  protected readonly data = inject(TeamDataService);
  protected readonly pendingRemoval = signal<TeamMember | undefined>(undefined);
  protected readonly savingUserId = signal<string | undefined>(undefined);
  protected readonly session = inject(SessionService);
  protected readonly organizationId: string;
  protected readonly membership = computed(() =>
    this.session.organizations().find(({ id }) => id === this.organizationId),
  );
  protected readonly assignableRoles = computed(() =>
    this.membership()?.role === 'OWNER'
      ? delegatedRoles.concat('ADMIN')
      : delegatedRoles,
  );
  protected readonly memberForm = new FormGroup({
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
  private readonly filters = inject(WorkspaceFilterService);
  private readonly toasts = inject(ToastService);

  constructor() {
    const organizationId =
      inject(ActivatedRoute).snapshot.paramMap.get('organizationId');
    if (!organizationId) throw new Error('Organization route is incomplete');
    this.organizationId = organizationId;
    this.filters.setOrganization(organizationId, this.session.organizations());
    void this.data.load(organizationId);
  }

  protected canManage(member: TeamMember): boolean {
    const role = this.membership()?.role;
    return (
      role === 'OWNER' ||
      (role === 'ADMIN' && delegatedRoles.includes(member.role))
    );
  }

  protected rolesFor(): OrganizationRole[] {
    return this.membership()?.role === 'OWNER' ? allRoles : delegatedRoles;
  }

  protected async addMember(): Promise<void> {
    if (this.memberForm.invalid) {
      this.memberForm.markAllAsTouched();
      return;
    }
    const added = await this.data.addMember(
      this.organizationId,
      this.memberForm.getRawValue(),
    );
    if (!added) return;
    this.memberForm.reset({ email: '', role: 'VIEWER' });
    this.toasts.success(
      'Member added',
      'The new organization role is active and recorded in audit history.',
    );
  }

  protected async changeRole(member: TeamMember, event: Event): Promise<void> {
    const role = (event.target as HTMLSelectElement).value;
    if (!isRole(role) || role === member.role) return;

    this.savingUserId.set(member.userId);
    const updated = await this.data.updateMember(
      this.organizationId,
      member.userId,
      { role },
    );
    this.savingUserId.set(undefined);
    if (updated) {
      this.toasts.success(
        'Role updated',
        'The permission change is active and has been audited.',
      );
    }
  }

  protected async confirmRemoval(): Promise<void> {
    const member = this.pendingRemoval();
    if (!member) return;
    this.savingUserId.set(member.userId);
    const removed = await this.data.removeMember(
      this.organizationId,
      member.userId,
    );
    this.savingUserId.set(undefined);
    if (!removed) return;
    this.pendingRemoval.set(undefined);
    this.toasts.success(
      'Access removed',
      'The member no longer has access to this organization.',
    );
  }

  protected eventLabel(type: string): string {
    return type
      .replace('membership.', '')
      .replace('organization.', '')
      .replaceAll('_', ' ');
  }
}

function isRole(value: string): value is OrganizationRole {
  return allRoles.includes(value as OrganizationRole);
}
