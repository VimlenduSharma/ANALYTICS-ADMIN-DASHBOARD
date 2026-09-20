import type { SessionResponse } from '@analytics-admin/contracts';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CookieService } from './cookie.service';
import { IdentityRepository } from './identity.repository';
import { OidcService } from './oidc.service';
import type { RequestIdentity } from './request-identity';
import { SessionService } from './session.service';

@Injectable()
export class AuthenticationService {
  constructor(
    private readonly cookies: CookieService,
    private readonly identityRepository: IdentityRepository,
    private readonly oidc: OidcService,
    private readonly sessions: SessionService,
  ) {}

  async authenticate(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<RequestIdentity> {
    const token = request.cookies[this.cookies.sessionCookieName];
    const resolved = await this.sessions.resolve(token);
    if (!resolved) {
      this.cookies.clearSession(reply);
      throw new UnauthorizedException({
        code: 'AUTH_REQUIRED',
        message: 'Sign in is required',
      });
    }

    const user = await this.identityRepository.findUser(resolved.record.userId);
    if (!user) {
      await this.sessions.revoke(resolved.token);
      this.cookies.clearSession(reply);
      throw new UnauthorizedException({
        code: 'SESSION_REVOKED',
        message: 'Your session is no longer active',
      });
    }

    this.cookies.setSession(reply, resolved.token);
    const identity = {
      session: resolved.record,
      sessionToken: resolved.token,
      user,
    };
    request.identity = identity;
    return identity;
  }

  async session(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<SessionResponse> {
    try {
      const identity = await this.authenticate(request, reply);
      return {
        authenticated: true,
        csrfToken: identity.session.csrfToken,
        organizations: await this.identityRepository.organizationsForUser(
          identity.user.id,
        ),
        user: identity.user,
      };
    } catch (error) {
      if (!(error instanceof UnauthorizedException)) throw error;
      return { authenticated: false, loginAvailable: this.oidc.available };
    }
  }
}
