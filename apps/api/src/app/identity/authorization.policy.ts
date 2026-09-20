import type { OrganizationRole } from '@analytics-admin/contracts';

const manageableRoles: Record<OrganizationRole, readonly OrganizationRole[]> = {
  OWNER: ['OWNER', 'ADMIN', 'ANALYST', 'VIEWER'],
  ADMIN: ['ANALYST', 'VIEWER'],
  ANALYST: [],
  VIEWER: [],
};

export function canAssignRole(
  actorRole: OrganizationRole,
  assignedRole: OrganizationRole,
): boolean {
  return manageableRoles[actorRole].includes(assignedRole);
}

export function canManageMember(
  actorRole: OrganizationRole,
  targetRole: OrganizationRole,
): boolean {
  return (
    actorRole === 'OWNER' || manageableRoles[actorRole].includes(targetRole)
  );
}
