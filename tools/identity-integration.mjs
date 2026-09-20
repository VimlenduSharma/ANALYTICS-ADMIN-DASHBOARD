import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createClient } from 'redis';

const databaseUrl = requiredEnvironment('DATABASE_URL');
const redisUrl = requiredEnvironment('REDIS_URL');
const port = 31_000 + Math.floor(Math.random() * 1_000);
const baseUrl = `http://127.0.0.1:${port}`;
const webOrigin = 'http://localhost:4200';
const runId = randomBytes(8).toString('hex');
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const redis = createClient({ url: redisUrl });
const createdOrganizationIds = [];
const createdUserIds = [];
const sessionTokens = [];
const serverOutput = [];

const server = spawn(process.execPath, ['dist/apps/api/main.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    API_HOST: '127.0.0.1',
    API_PORT: String(port),
    APP_VERSION: 'identity-integration',
    NODE_ENV: 'test',
    OIDC_CLIENT_ID: '',
    OIDC_CLIENT_SECRET: '',
    OIDC_ISSUER_URL: '',
    OIDC_REDIRECT_URI: '',
    WEB_ORIGIN: webOrigin,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

for (const stream of [server.stdout, server.stderr]) {
  stream.on('data', (chunk) => {
    serverOutput.push(String(chunk));
    if (serverOutput.length > 30) serverOutput.shift();
  });
}

try {
  await redis.connect();
  await waitForApi();

  const ownerA = await createUser('Owner A');
  const ownerB = await createUser('Owner B');
  const admin = await createUser('Admin');
  const viewer = await createUser('Viewer');
  const analyst = await createUser('Analyst');

  const ownerASession = await createSession(ownerA.id);
  const ownerBSession = await createSession(ownerB.id);
  const adminSession = await createSession(admin.id);
  const viewerSession = await createSession(viewer.id);

  const organizationA = await expectJson(
    'owner creates organization A',
    await request('/api/v1/organizations', {
      body: { name: `Identity Gate A ${runId}` },
      csrf: ownerASession.csrf,
      method: 'POST',
      token: ownerASession.token,
    }),
    201,
  );
  const organizationB = await expectJson(
    'owner creates organization B',
    await request('/api/v1/organizations', {
      body: { name: `Identity Gate B ${runId}` },
      csrf: ownerBSession.csrf,
      method: 'POST',
      token: ownerBSession.token,
    }),
    201,
  );
  createdOrganizationIds.push(organizationA.id, organizationB.id);

  await addMembership(organizationA.id, admin.id, 'ADMIN', ownerA.id);
  await addMembership(organizationA.id, viewer.id, 'VIEWER', ownerA.id);

  const unauthenticated = await expectJson(
    'protected API rejects an anonymous request',
    await request(`/api/v1/organizations/${organizationA.id}/team`),
    401,
  );
  assert.equal(unauthenticated.code, 'AUTH_REQUIRED');
  assert.equal(typeof unauthenticated.requestId, 'string');

  const crossTenant = await expectJson(
    'cross-tenant access fails closed',
    await request(`/api/v1/organizations/${organizationB.id}/team`, {
      token: ownerASession.token,
    }),
    403,
  );
  assert.equal(crossTenant.code, 'ORGANIZATION_ACCESS_DENIED');

  await expectStatus(
    'viewer cannot access the management API',
    await request(`/api/v1/organizations/${organizationA.id}/team`, {
      token: viewerSession.token,
    }),
    403,
  );

  await expectStatus(
    'admin cannot escalate a member to owner',
    await request(
      `/api/v1/organizations/${organizationA.id}/team/${viewer.id}`,
      {
        body: { role: 'OWNER' },
        csrf: adminSession.csrf,
        method: 'PATCH',
        token: adminSession.token,
      },
    ),
    403,
  );

  const missingCsrf = await expectJson(
    'unsafe request requires a CSRF token',
    await request('/api/v1/organizations', {
      body: { name: `Rejected ${runId}` },
      method: 'POST',
      token: ownerASession.token,
    }),
    403,
  );
  assert.equal(missingCsrf.code, 'CSRF_INVALID');

  const invalidOrigin = await expectJson(
    'unsafe request requires the trusted origin',
    await request('/api/v1/organizations', {
      body: { name: `Rejected ${runId}` },
      csrf: ownerASession.csrf,
      method: 'POST',
      origin: 'https://attacker.invalid',
      token: ownerASession.token,
    }),
    403,
  );
  assert.equal(invalidOrigin.code, 'CSRF_ORIGIN_INVALID');

  await expectStatus(
    'the final owner cannot be demoted',
    await request(
      `/api/v1/organizations/${organizationA.id}/team/${ownerA.id}`,
      {
        body: { role: 'ADMIN' },
        csrf: ownerASession.csrf,
        method: 'PATCH',
        token: ownerASession.token,
      },
    ),
    409,
  );

  await expectStatus(
    'owner adds an existing identity with a delegated role',
    await request(`/api/v1/organizations/${organizationA.id}/team`, {
      body: { email: analyst.email, role: 'ANALYST' },
      csrf: ownerASession.csrf,
      method: 'POST',
      token: ownerASession.token,
    }),
    201,
  );
  const auditEvents = await expectJson(
    'organization audit events are readable by managers',
    await request(`/api/v1/organizations/${organizationA.id}/audit-events`, {
      token: ownerASession.token,
    }),
    200,
  );
  assert.ok(
    auditEvents.some((event) => event.eventType === 'membership.created'),
  );

  const logoutSession = await createSession(ownerB.id);
  await expectStatus(
    'logout revokes its opaque session',
    await request('/api/v1/auth/logout', {
      body: {},
      csrf: logoutSession.csrf,
      method: 'POST',
      token: logoutSession.token,
    }),
    204,
  );
  await expectStatus(
    'logged-out token cannot reach a protected API',
    await request(`/api/v1/organizations/${organizationB.id}/team`, {
      token: logoutSession.token,
    }),
    401,
  );

  const revokeFirst = await createSession(admin.id);
  const revokeSecond = await createSession(admin.id);
  await expectStatus(
    'user can revoke all active sessions',
    await request('/api/v1/auth/sessions/revoke', {
      body: {},
      csrf: revokeFirst.csrf,
      method: 'POST',
      token: revokeFirst.token,
    }),
    204,
  );
  for (const token of [revokeFirst.token, revokeSecond.token]) {
    await expectStatus(
      'bulk-revoked token cannot reach a protected API',
      await request(`/api/v1/organizations/${organizationA.id}/team`, {
        token,
      }),
      401,
    );
  }

  const rotationSession = await createSession(ownerA.id, 901);
  const rotatedResponse = await request('/api/v1/auth/session', {
    token: rotationSession.token,
  });
  const rotatedBody = await expectJson(
    'an aged session rotates during resolution',
    rotatedResponse,
    200,
  );
  assert.equal(rotatedBody.authenticated, true);
  const rotatedToken = cookieValue(rotatedResponse, 'aad_session');
  assert.notEqual(rotatedToken, rotationSession.token);
  sessionTokens.push(rotatedToken);

  const staleSession = await expectJson(
    'the pre-rotation token is invalidated',
    await request('/api/v1/auth/session', { token: rotationSession.token }),
    200,
  );
  assert.equal(staleSession.authenticated, false);

  console.log(
    'Identity integration gate passed: 16 fail-closed and lifecycle checks.',
  );
} catch (error) {
  const diagnostics = serverOutput.join('').trim();
  if (diagnostics) console.error(diagnostics);
  throw error;
} finally {
  await cleanup();
  server.kill('SIGTERM');
  await Promise.race([onceExited(server), delay(2_000)]);
  if (server.exitCode === null) server.kill('SIGKILL');
  if (redis.isOpen) await redis.quit();
  await pool.end();
}

async function createUser(label) {
  const email = `${label.toLowerCase().replaceAll(' ', '.')}+${runId}@identity.test`;
  const result = await pool.query(
    `
      INSERT INTO identity_users (issuer, subject, email, display_name)
      VALUES ($1, $2, $3, $4)
      RETURNING id, email
    `,
    [
      `urn:analytics-admin:integration:${runId}`,
      `${label}-${runId}`,
      email,
      label,
    ],
  );
  const user = result.rows[0];
  assert.ok(user);
  createdUserIds.push(user.id);
  return user;
}

async function addMembership(organizationId, userId, role, actorUserId) {
  await pool.query(
    `
      INSERT INTO organization_memberships (
        organization_id, user_id, role, created_by_user_id
      ) VALUES ($1, $2, $3, $4)
    `,
    [organizationId, userId, role, actorUserId],
  );
}

async function createSession(userId, ageSeconds = 0) {
  const token = randomBytes(32).toString('base64url');
  const csrf = randomBytes(32).toString('base64url');
  const now = Math.floor(Date.now() / 1_000);
  const key = sessionKey(token);
  const record = {
    absoluteExpiresAt: now + 86_400,
    createdAt: now - ageSeconds,
    csrfToken: csrf,
    rotatedAt: now - ageSeconds,
    userId,
  };
  await redis.set(key, JSON.stringify(record), { EX: 28_800 });
  await redis.sAdd(userSessionsKey(userId), key);
  await redis.expire(userSessionsKey(userId), 28_800);
  sessionTokens.push(token);
  return { csrf, token };
}

async function request(path, options = {}) {
  const headers = { accept: 'application/json' };
  if (options.token) headers.cookie = `aad_session=${options.token}`;
  if (options.csrf) headers['x-csrf-token'] = options.csrf;
  if (options.method && options.method !== 'GET') {
    headers.origin = options.origin ?? webOrigin;
  }
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  return fetch(`${baseUrl}${path}`, {
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    headers,
    method: options.method ?? 'GET',
    redirect: 'manual',
  });
}

async function expectJson(label, response, status) {
  const text = await expectStatus(label, response, status);
  assert.notEqual(text, '', `${label}: expected a JSON response body`);
  return JSON.parse(text);
}

async function expectStatus(label, response, status) {
  const text = await response.text();
  assert.equal(
    response.status,
    status,
    `${label}: expected ${status}, received ${response.status}: ${text}`,
  );
  return text;
}

function cookieValue(response, name) {
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${name}=`));
  assert.ok(cookie, `Expected ${name} response cookie`);
  return cookie.slice(name.length + 1).split(';', 1)[0];
}

async function waitForApi() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Identity API exited with code ${server.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/v1/health/ready`);
      if (response.ok) return;
    } catch {
      // Startup is still in progress.
    }
    await delay(150);
  }
  throw new Error('Identity API did not become ready within 15 seconds');
}

async function cleanup() {
  if (redis.isOpen) {
    const keys = sessionTokens.map(sessionKey);
    const indexes = createdUserIds.map(userSessionsKey);
    if (keys.length) await redis.del(keys);
    if (indexes.length) await redis.del(indexes);
  }
  if (createdUserIds.length) {
    await pool.query(
      `
        DELETE FROM audit_events
        WHERE actor_user_id = ANY($1::uuid[])
           OR organization_id = ANY($2::uuid[])
      `,
      [createdUserIds, createdOrganizationIds],
    );
  }
  if (createdOrganizationIds.length) {
    await pool.query('DELETE FROM organizations WHERE id = ANY($1::uuid[])', [
      createdOrganizationIds,
    ]);
  }
  if (createdUserIds.length) {
    await pool.query('DELETE FROM identity_users WHERE id = ANY($1::uuid[])', [
      createdUserIds,
    ]);
  }
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
    throw new Error(`${name} is required for identity integration tests`);
  return value;
}

function onceExited(child) {
  return new Promise((resolve) => child.once('exit', resolve));
}
