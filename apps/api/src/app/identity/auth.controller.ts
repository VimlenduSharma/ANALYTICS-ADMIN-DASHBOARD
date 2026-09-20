import type { Environment } from '@analytics-admin/config';
import type { SessionResponse } from '@analytics-admin/contracts';
import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthenticationService } from './authentication.service';
import { AuthGuard } from './auth.guard';
import { CookieService } from './cookie.service';
import { CsrfGuard } from './csrf.guard';
import { IdentityRepository } from './identity.repository';
import { OidcService } from './oidc.service';
import { requestIdentity } from './request-identity';
import { SessionService } from './session.service';

@Controller({ path: 'auth', version: '1' })
export class AuthController {
  private readonly redirectUri?: string;
  private readonly webOrigin: string;

  constructor(
    private readonly authentication: AuthenticationService,
    private readonly config: ConfigService<Environment, true>,
    private readonly cookies: CookieService,
    private readonly identityRepository: IdentityRepository,
    private readonly oidc: OidcService,
    private readonly sessions: SessionService,
  ) {
    this.redirectUri = config.get('OIDC_REDIRECT_URI');
    this.webOrigin = config.getOrThrow('WEB_ORIGIN');
  }

  @Get('session')
  session(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SessionResponse> {
    return this.authentication.session(request, reply);
  }

  @Get('login')
  async login(
    @Query('returnTo') requestedReturnTo: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    if (!this.oidc.available) {
      reply
        .code(HttpStatus.FOUND)
        .redirect(this.webUrl('/sign-in?error=provider_unavailable'));
      return;
    }

    try {
      const transaction = await this.oidc.begin(
        safeReturnTo(requestedReturnTo),
      );
      this.cookies.setOidcTransaction(reply, transaction.state);
      reply.code(HttpStatus.FOUND).redirect(transaction.url.toString());
    } catch {
      reply
        .code(HttpStatus.FOUND)
        .redirect(this.webUrl('/sign-in?error=provider_unavailable'));
    }
  }

  @Get('callback')
  async callback(
    @Query('state') state: string | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    try {
      const redirectUri = this.redirectUri;
      if (!redirectUri) throw new Error('OIDC redirect URI is unavailable');
      const callbackUrl = new URL(request.url, redirectUri);
      const result = await this.oidc.complete(
        callbackUrl,
        state,
        request.cookies[this.cookies.oidcCookieName],
      );
      const user = await this.identityRepository.upsertOidcUser(
        result.identity,
      );
      const session = await this.sessions.create(user.id);
      this.cookies.clearOidcTransaction(reply);
      this.cookies.setSession(reply, session.token);
      reply.code(HttpStatus.FOUND).redirect(this.webUrl(result.returnTo));
    } catch {
      this.cookies.clearOidcTransaction(reply);
      reply
        .code(HttpStatus.FOUND)
        .redirect(this.webUrl('/sign-in?error=identity_callback_failed'));
    }
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(AuthGuard, CsrfGuard)
  async logout(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    await this.sessions.revoke(requestIdentity(request).sessionToken);
    this.cookies.clearSession(reply);
  }

  @Post('sessions/revoke')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(AuthGuard, CsrfGuard)
  async revokeAll(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    await this.sessions.revokeAll(requestIdentity(request).user.id);
    this.cookies.clearSession(reply);
  }

  private webUrl(path: string): string {
    return new URL(path, this.webOrigin).toString();
  }
}

function safeReturnTo(value: string | undefined): string {
  return value?.startsWith('/') && !value.startsWith('//') ? value : '/';
}
