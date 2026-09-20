import { canAssignRole, canManageMember } from './authorization.policy';

describe('organization authorization policy', () => {
  it('lets owners assign every role', () => {
    expect(canAssignRole('OWNER', 'OWNER')).toBe(true);
    expect(canAssignRole('OWNER', 'ADMIN')).toBe(true);
  });

  it('limits administrators to analyst and viewer roles', () => {
    expect(canAssignRole('ADMIN', 'ANALYST')).toBe(true);
    expect(canAssignRole('ADMIN', 'VIEWER')).toBe(true);
    expect(canAssignRole('ADMIN', 'ADMIN')).toBe(false);
    expect(canAssignRole('ADMIN', 'OWNER')).toBe(false);
  });

  it('prevents analyst and viewer membership management', () => {
    expect(canManageMember('ANALYST', 'VIEWER')).toBe(false);
    expect(canManageMember('VIEWER', 'VIEWER')).toBe(false);
  });
});
