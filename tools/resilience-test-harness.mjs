import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createClient } from 'redis';

export const webOrigin = 'http://localhost:4200';

export class ResilienceHarness {
  constructor(options = {}) {
    this.databaseUrl = requiredEnvironment('DATABASE_URL');
    this.redisUrl = requiredEnvironment('REDIS_URL');
    this.port = options.port ?? 35_000 + Math.floor(Math.random() * 1_000);
    this.baseUrl = `http://127.0.0.1:${this.port}`;
    this.runId = randomBytes(8).toString('hex');
    this.pool = new Pool({ connectionString: this.databaseUrl, max: 3 });
    this.redis = createClient({ url: this.redisUrl });
    this.childEnvironment = options.environment ?? {};
    this.organizationIds = [];
    this.output = [];
    this.sessionTokens = [];
    this.userIds = [];
  }

  async start() {
    await this.redis.connect();
    this.api = spawn(process.execPath, ['dist/apps/api/main.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_HOST: '127.0.0.1',
        API_PORT: String(this.port),
        APP_VERSION: 'resilience-integration',
        NODE_ENV: 'test',
        OIDC_CLIENT_ID: '',
        OIDC_CLIENT_SECRET: '',
        OIDC_ISSUER_URL: '',
        OIDC_REDIRECT_URI: '',
        WEB_ORIGIN: webOrigin,
        ...this.childEnvironment,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [this.api.stdout, this.api.stderr]) {
      stream.on('data', (chunk) => {
        this.output.push(String(chunk));
        if (this.output.length > 80) this.output.shift();
      });
    }
    await this.waitForApi();
    return this;
  }

  async createTenant(label = 'Resilience Owner') {
    const tenantId = `${this.runId}-${this.userIds.length + 1}`;
    const userResult = await this.pool.query(
      `INSERT INTO identity_users (issuer, subject, email, display_name)
       VALUES ($1, $2, $3, $4) RETURNING id, email`,
      [
        `urn:analytics-admin:resilience:${this.runId}`,
        `${label}-${tenantId}`,
        `${label.toLowerCase().replaceAll(' ', '.')}+${tenantId}@integration.test`,
        label,
      ],
    );
    const user = userResult.rows[0];
    assert.ok(user);
    this.userIds.push(user.id);

    const organizationResult = await this.pool.query(
      `INSERT INTO organizations (slug, name, created_by_user_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [`resilience-${tenantId}`, `Resilience ${tenantId}`, user.id],
    );
    const organization = organizationResult.rows[0];
    assert.ok(organization);
    this.organizationIds.push(organization.id);
    await this.pool.query(
      `INSERT INTO organization_memberships (
         organization_id, user_id, role, created_by_user_id
       ) VALUES ($1, $2, 'OWNER', $2)`,
      [organization.id, user.id],
    );
    return {
      organizationId: organization.id,
      session: await this.createSession(user.id),
      user,
    };
  }

  async createSession(userId) {
    const token = randomBytes(32).toString('base64url');
    const csrf = randomBytes(32).toString('base64url');
    const now = Math.floor(Date.now() / 1_000);
    const key = sessionKey(token);
    await this.redis.set(
      key,
      JSON.stringify({
        absoluteExpiresAt: now + 86_400,
        createdAt: now,
        csrfToken: csrf,
        rotatedAt: now,
        userId,
      }),
      { EX: 28_800 },
    );
    await this.redis.sAdd(userSessionsKey(userId), key);
    await this.redis.expire(userSessionsKey(userId), 28_800);
    this.sessionTokens.push(token);
    return { csrf, token };
  }

  authenticatedRequest(path, session, options = {}) {
    return this.request(path, {
      ...options,
      csrf: session.csrf,
      token: session.token,
    });
  }

  request(path, options = {}) {
    const headers = { accept: 'application/json', ...options.headers };
    if (options.token) headers.cookie = `aad_session=${options.token}`;
    if (options.csrf) headers['x-csrf-token'] = options.csrf;
    if (options.method && options.method !== 'GET' && options.token) {
      headers.origin = options.origin ?? webOrigin;
    }
    if (options.body !== undefined && !headers['content-type']) {
      headers['content-type'] = 'application/json';
    }
    const body =
      options.bodyText ??
      (options.body === undefined ? undefined : JSON.stringify(options.body));
    return fetch(`${this.baseUrl}${path}`, {
      body,
      headers,
      method: options.method ?? 'GET',
      redirect: 'manual',
    });
  }

  async expectJson(label, response, status) {
    const text = await this.expectStatus(label, response, status);
    assert.notEqual(text, '', `${label}: expected a JSON response body`);
    return JSON.parse(text);
  }

  async expectStatus(label, response, status) {
    const text = await response.text();
    assert.equal(
      response.status,
      status,
      `${label}: expected ${status}, received ${response.status}: ${text}`,
    );
    return text;
  }

  async stop({ assertGraceful = false } = {}) {
    if (this.stopped)
      return this.shutdown ?? { durationMs: 0, exitCode: this.api?.exitCode };
    this.stopped = true;
    await this.cleanup();
    const startedAt = performance.now();
    if (this.api?.exitCode === null) this.api.kill('SIGTERM');
    if (this.api) {
      await Promise.race([onceExited(this.api), delay(5_000)]);
      if (this.api.exitCode === null) this.api.kill('SIGKILL');
    }
    const durationMs = performance.now() - startedAt;
    if (assertGraceful) {
      assert.notEqual(this.api?.signalCode, 'SIGKILL');
      assert.ok(durationMs < 5_000, `API shutdown took ${durationMs}ms`);
    }
    if (this.redis.isReady) await this.redis.quit();
    else if (this.redis.isOpen) this.redis.destroy();
    await this.pool.end();
    this.shutdown = { durationMs, exitCode: this.api?.exitCode };
    return this.shutdown;
  }

  diagnostics() {
    return this.output.join('').trim();
  }

  async waitForApi() {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (this.api.exitCode !== null) {
        throw new Error(
          `Resilience API exited with ${this.api.exitCode}: ${this.diagnostics()}`,
        );
      }
      try {
        const response = await fetch(`${this.baseUrl}/api/v1/health/ready`);
        if (response.ok) return;
      } catch {
        // The process is still binding or running migrations.
      }
      await delay(150);
    }
    throw new Error(
      `Resilience API did not become ready: ${this.diagnostics()}`,
    );
  }

  async cleanup() {
    if (this.redis.isReady) {
      if (this.sessionTokens.length) {
        await this.redis.del(this.sessionTokens.map(sessionKey));
      }
      if (this.userIds.length) {
        await this.redis.del(this.userIds.map(userSessionsKey));
      }
      for await (const keys of this.redis.scanIterator({
        MATCH: `resilience:*${this.runId}*`,
      })) {
        if (keys.length) await this.redis.del(keys);
      }
    }
    if (this.organizationIds.length) {
      await this.pool.query(
        'DELETE FROM audit_events WHERE organization_id = ANY($1::uuid[])',
        [this.organizationIds],
      );
      await this.pool.query(
        'DELETE FROM organizations WHERE id = ANY($1::uuid[])',
        [this.organizationIds],
      );
    }
    if (this.userIds.length) {
      await this.pool.query(
        'DELETE FROM identity_users WHERE id = ANY($1::uuid[])',
        [this.userIds],
      );
    }
  }
}

export function orderPayload(
  externalId,
  occurredAt = new Date().toISOString(),
) {
  return {
    channel: {
      externalId: 'resilience-store',
      kind: 'storefront',
      name: 'Resilience Store',
    },
    currency: 'USD',
    customerReference: { externalId: `customer-${externalId}` },
    discountMinor: 0,
    externalId,
    fulfilments: [],
    items: [
      {
        externalId: 'line-1',
        name: 'Load-safe product',
        productExternalId: 'resilience-product',
        quantity: 1,
        sku: 'RES-001',
        totalMinor: 5_000,
        unitPriceMinor: 5_000,
      },
    ],
    location: {
      countryCode: 'US',
      externalId: 'resilience-warehouse',
      kind: 'warehouse',
      name: 'Resilience Warehouse',
      timezone: 'UTC',
    },
    occurredAt,
    orderNumber: `ORDER-${externalId}`,
    payment: {
      authorizedMinor: 5_000,
      capturedMinor: 5_000,
      refundedMinor: 0,
      status: 'captured',
    },
    returns: [],
    status: 'confirmed',
    subtotalMinor: 5_000,
    taxMinor: 0,
    totalMinor: 5_000,
  };
}

function sessionKey(token) {
  return `identity:session:${createHash('sha256').update(token).digest('hex')}`;
}

function userSessionsKey(userId) {
  return `identity:user-sessions:${userId}`;
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value)
    throw new Error(`${name} is required for resilience verification`);
  return value;
}

function onceExited(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(child.exitCode);
  }
  return new Promise((resolve) => {
    child.once('exit', resolve);
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode);
    }
  });
}
