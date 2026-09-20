import type {
  AddTeamMemberRequest,
  AuditEventSummary,
  CreateOrganizationRequest,
  OrganizationAccess,
  TeamMember,
  TeamResponse,
  UpdateTeamMemberRequest,
} from '@analytics-admin/contracts';
import { Injectable } from '@nestjs/common';
import { IdentityRepository } from './identity.repository';

@Injectable()
export class TeamService {
  constructor(private readonly identityRepository: IdentityRepository) {}

  organizations(userId: string): Promise<OrganizationAccess[]> {
    return this.identityRepository.organizationsForUser(userId);
  }

  createOrganization(
    userId: string,
    request: CreateOrganizationRequest,
  ): Promise<OrganizationAccess> {
    return this.identityRepository.createOrganization(userId, request.name);
  }

  team(organizationId: string): Promise<TeamResponse> {
    return this.identityRepository.team(organizationId);
  }

  addMember(
    actorUserId: string,
    organizationId: string,
    request: AddTeamMemberRequest,
  ): Promise<TeamMember> {
    return this.identityRepository.addMember({
      actorUserId,
      email: request.email,
      organizationId,
      role: request.role,
    });
  }

  updateMember(
    actorUserId: string,
    organizationId: string,
    targetUserId: string,
    request: UpdateTeamMemberRequest,
  ): Promise<void> {
    return this.identityRepository.updateMemberRole({
      actorUserId,
      organizationId,
      role: request.role,
      targetUserId,
    });
  }

  removeMember(
    actorUserId: string,
    organizationId: string,
    targetUserId: string,
  ): Promise<void> {
    return this.identityRepository.removeMember({
      actorUserId,
      organizationId,
      targetUserId,
    });
  }

  auditEvents(organizationId: string): Promise<AuditEventSummary[]> {
    return this.identityRepository.auditEvents(organizationId);
  }
}
