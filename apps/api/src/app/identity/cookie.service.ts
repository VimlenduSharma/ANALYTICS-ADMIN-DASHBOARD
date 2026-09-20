import type { Environment } from '@analytics-admin/config';
import '@fastify/cookie';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyReply } from 'fastify';

@Injectable()
export class CookieService {
  readonly oidcCookieName: string;
  readonly sessionCookieName: string;
  private readonly secure: boolean;
  private readonly sessionMaxAge: number;

  constructor(config: ConfigService<Environment, true>) {
    this.secure = config.getOrThrow('NODE_ENV') === 'production';
    this.oidcCookieName = this.secure ? '__Host-aad_oidc' : 'aad_oidc';
    this.sessionCookieName = this.secure ? '__Host-aad_session' : 'aad_session';
    this.sessionMaxAge = config.getOrThrow('SESSION_IDLE_TTL_SECONDS');
  }

  setSession(reply: FastifyReply, token: string): void {
    reply.setCookie(this.sessionCookieName, token, {
      httpOnly: true,
      maxAge: this.sessionMaxAge,
      path: '/',
      sameSite: 'lax',
      secure: this.secure,
    });
  }

  clearSession(reply: FastifyReply): void {
    reply.clearCookie(this.sessionCookieName, {
      httpOnly: true,
      path: '/',
      sameSite: 'lax',
      secure: this.secure,
    });
  }

  setOidcTransaction(reply: FastifyReply, state: string): void {
    reply.setCookie(this.oidcCookieName, state, {
      httpOnly: true,
      maxAge: 600,
      path: '/',
      sameSite: 'lax',
      secure: this.secure,
    });
  }

  clearOidcTransaction(reply: FastifyReply): void {
    reply.clearCookie(this.oidcCookieName, {
      httpOnly: true,
      path: '/',
      sameSite: 'lax',
      secure: this.secure,
    });
  }
}
