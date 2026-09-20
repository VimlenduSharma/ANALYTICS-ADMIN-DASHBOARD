import type { Environment } from '@analytics-admin/config';
import type { ConfigService } from '@nestjs/config';
import type { FastifyReply } from 'fastify';
import { CookieService } from './cookie.service';

describe('CookieService', () => {
  it('uses host-bound secure cookies in production', () => {
    const service = new CookieService(config('production'));
    const setCookie = jest.fn();
    const clearCookie = jest.fn();
    const reply = { clearCookie, setCookie } as unknown as FastifyReply;

    service.setSession(reply, 'opaque-session');
    service.setOidcTransaction(reply, 'transaction-state');
    service.clearSession(reply);

    expect(service.sessionCookieName).toBe('__Host-aad_session');
    expect(service.oidcCookieName).toBe('__Host-aad_oidc');
    expect(setCookie).toHaveBeenCalledWith(
      '__Host-aad_session',
      'opaque-session',
      expect.objectContaining({
        httpOnly: true,
        path: '/',
        sameSite: 'lax',
        secure: true,
      }),
    );
    expect(setCookie).toHaveBeenCalledWith(
      '__Host-aad_oidc',
      'transaction-state',
      expect.objectContaining({ httpOnly: true, path: '/', secure: true }),
    );
    expect(clearCookie).toHaveBeenCalledWith(
      '__Host-aad_session',
      expect.objectContaining({ httpOnly: true, path: '/', secure: true }),
    );
  });

  it('permits localhost HTTP without weakening cookie isolation', () => {
    const service = new CookieService(config('development'));
    const setCookie = jest.fn();
    const reply = { setCookie } as unknown as FastifyReply;

    service.setSession(reply, 'opaque-session');

    expect(service.sessionCookieName).toBe('aad_session');
    expect(setCookie).toHaveBeenCalledWith(
      'aad_session',
      'opaque-session',
      expect.objectContaining({
        httpOnly: true,
        sameSite: 'lax',
        secure: false,
      }),
    );
  });
});

function config(
  nodeEnvironment: Environment['NODE_ENV'],
): ConfigService<Environment, true> {
  return {
    getOrThrow: jest.fn((key: keyof Environment) =>
      key === 'NODE_ENV' ? nodeEnvironment : 28_800,
    ),
  } as unknown as ConfigService<Environment, true>;
}
