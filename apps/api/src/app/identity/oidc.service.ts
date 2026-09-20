import type { Environment } from '@analytics-admin/config';
import { CircuitBreaker } from '@analytics-admin/resilience';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import * as oidc from 'openid-client';
import { z } from 'zod';
import { RedisService } from '../infrastructure/redis.service';

const transactionSchema = z.object({
  codeVerifier: z.string().min(43),
  nonce: z.string().min(16),
  returnTo: z.string().startsWith('/'),
  state: z.string().min(16),
});

interface OidcIdentity {
  avatarUrl?: string;
  displayName: string;
  email: string;
  issuer: string;
  subject: string;
}

interface OidcSettings {
  clientId: string;
  clientSecret: string;
  issuerUrl: string;
  redirectUri: string;
}

@Injectable()
export class OidcService {
  private readonly allowInsecureProvider: boolean;
  private configuration?: Promise<oidc.Configuration>;
  private readonly clientId?: string;
  private readonly clientSecret?: string;
  private readonly issuerUrl?: string;
  private readonly providerCircuit: CircuitBreaker;
  private readonly redirectUri?: string;

  constructor(
    config: ConfigService<Environment, true>,
    private readonly redis: RedisService,
  ) {
    this.allowInsecureProvider = config.getOrThrow('NODE_ENV') === 'test';
    this.clientId = config.get('OIDC_CLIENT_ID');
    this.clientSecret = config.get('OIDC_CLIENT_SECRET');
    this.issuerUrl = config.get('OIDC_ISSUER_URL');
    this.redirectUri = config.get('OIDC_REDIRECT_URI');
    this.providerCircuit = new CircuitBreaker('oidc-provider', {
      failureThreshold: config.getOrThrow('CIRCUIT_FAILURE_THRESHOLD'),
      resetAfterMs: config.getOrThrow('CIRCUIT_RESET_MS'),
      timeoutMs: config.getOrThrow('DEPENDENCY_TIMEOUT_MS') * 4,
    });
  }

  get available(): boolean {
    return Boolean(
      this.clientId && this.clientSecret && this.issuerUrl && this.redirectUri,
    );
  }

  async begin(returnTo: string): Promise<{ state: string; url: URL }> {
    const settings = this.requireSettings();
    const configuration = await this.getConfiguration();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const transaction = {
      codeVerifier,
      nonce: oidc.randomNonce(),
      returnTo,
      state,
    };

    await this.redis.use((client) =>
      client.set(transactionKey(state), JSON.stringify(transaction), {
        EX: 600,
        NX: true,
      }),
    );
    const url = oidc.buildAuthorizationUrl(configuration, {
      client_id: settings.clientId,
      code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: 'S256',
      nonce: transaction.nonce,
      redirect_uri: settings.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
    });
    return { state, url };
  }

  async complete(
    callbackUrl: URL,
    state: string | undefined,
    cookieState: string | undefined,
  ): Promise<{ identity: OidcIdentity; returnTo: string }> {
    if (!state || !cookieState || !safeEqual(state, cookieState)) {
      throw new Error('OIDC transaction state does not match');
    }

    const serialized = await this.redis.use((client) =>
      client.getDel(transactionKey(state)),
    );
    const transaction = transactionSchema.safeParse(safeJson(serialized));
    if (!transaction.success) throw new Error('OIDC transaction has expired');

    const configuration = await this.getConfiguration();
    const tokens = await this.providerCircuit.execute(() =>
      oidc.authorizationCodeGrant(configuration, callbackUrl, {
        expectedNonce: transaction.data.nonce,
        expectedState: transaction.data.state,
        idTokenExpected: true,
        pkceCodeVerifier: transaction.data.codeVerifier,
      }),
    );
    const claims = tokens.claims();
    if (!claims) throw new Error('OIDC provider returned no ID token');

    const parsed = z
      .object({
        email: z.email(),
        email_verified: z.boolean().optional(),
        iss: z.url(),
        name: z.string().trim().min(1).max(120).optional(),
        picture: z.url().optional(),
        preferred_username: z.string().trim().min(1).max(120).optional(),
        sub: z.string().min(1).max(255),
      })
      .safeParse(claims);
    if (!parsed.success || parsed.data.email_verified === false) {
      throw new Error('OIDC provider did not return a verified email identity');
    }

    const displayName =
      parsed.data.name ?? parsed.data.preferred_username ?? parsed.data.email;
    return {
      identity: {
        ...(parsed.data.picture ? { avatarUrl: parsed.data.picture } : {}),
        displayName,
        email: parsed.data.email,
        issuer: parsed.data.iss,
        subject: parsed.data.sub,
      },
      returnTo: transaction.data.returnTo,
    };
  }

  private getConfiguration(): Promise<oidc.Configuration> {
    const settings = this.requireSettings();
    this.configuration ??= this.providerCircuit
      .execute(() =>
        oidc.discovery(
          new URL(settings.issuerUrl),
          settings.clientId,
          settings.clientSecret,
          undefined,
          {
            ...(this.allowInsecureProvider
              ? { execute: [oidc.allowInsecureRequests] }
              : {}),
            timeout: 5,
          },
        ),
      )
      .catch((error: unknown) => {
        this.configuration = undefined;
        throw error;
      });
    return this.configuration;
  }

  private requireSettings(): OidcSettings {
    if (
      !this.clientId ||
      !this.clientSecret ||
      !this.issuerUrl ||
      !this.redirectUri
    ) {
      throw new ServiceUnavailableException(
        'Identity provider is not configured',
      );
    }
    return {
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      issuerUrl: this.issuerUrl,
      redirectUri: this.redirectUri,
    };
  }
}

function transactionKey(state: string): string {
  return `identity:oidc:${createHash('sha256').update(state).digest('hex')}`;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function safeJson(value: string | null): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}
