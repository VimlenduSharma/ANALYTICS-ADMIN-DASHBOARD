import {
  dependencyNames,
  organizationRoles,
  type HealthResponse,
  type SessionResponse,
} from './contracts';

describe('contracts', () => {
  it('defines the required infrastructure dependencies', () => {
    expect(dependencyNames).toEqual(['postgres', 'redis']);
  });

  it('keeps the health contract serializable', () => {
    const response: HealthResponse = {
      service: 'analytics-api',
      status: 'ok',
      timestamp: '2026-09-02T00:00:00.000Z',
      uptimeSeconds: 12,
      version: '0.1.0',
    };

    expect(JSON.parse(JSON.stringify(response))).toEqual(response);
  });

  it('keeps organization roles ordered by authority', () => {
    expect(organizationRoles).toEqual(['OWNER', 'ADMIN', 'ANALYST', 'VIEWER']);
  });

  it('models unauthenticated sessions without user data', () => {
    const session: SessionResponse = {
      authenticated: false,
      loginAvailable: true,
    };

    expect(session).toEqual({ authenticated: false, loginAvailable: true });
  });
});
