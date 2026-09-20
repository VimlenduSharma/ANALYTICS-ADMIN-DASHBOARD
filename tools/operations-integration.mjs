import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createClient } from 'redis';

const databaseUrl = requiredEnvironment('DATABASE_URL');
const redisUrl = requiredEnvironment('REDIS_URL');
const port = 34_000 + Math.floor(Math.random() * 1_000);
const baseUrl = `http://127.0.0.1:${port}`;
const webOrigin = 'http://localhost:4200';
const runId = randomBytes(8).toString('hex');
const pool = new Pool({ connectionString: databaseUrl, max: 3 });
const redis = createClient({ url: redisUrl });
const organizationIds = [];
const userIds = [];
const sessionTokens = [];
const serverOutput = [];
const childEnvironment = {
  ...process.env,
  API_HOST: '127.0.0.1',
  API_PORT: String(port),
  APP_VERSION: 'operations-integration',
  NODE_ENV: 'test',
  OIDC_CLIENT_ID: '',
  OIDC_CLIENT_SECRET: '',
  OIDC_ISSUER_URL: '',
  OIDC_REDIRECT_URI: '',
  WEB_ORIGIN: webOrigin,
};
const api = spawn(process.execPath, ['dist/apps/api/main.js'], {
  cwd: process.cwd(),
  env: childEnvironment,
  stdio: ['ignore', 'pipe', 'pipe'],
});

for (const stream of [api.stdout, api.stderr]) {
  stream.on('data', (chunk) => {
    serverOutput.push(String(chunk));
    if (serverOutput.length > 50) serverOutput.shift();
  });
}

try {
  await redis.connect();
  await waitForApi();

  const ownerA = await createUser('Operations Owner A');
  const ownerB = await createUser('Operations Owner B');
  const analyst = await createUser('Operations Analyst');
  const viewer = await createUser('Operations Viewer');
  const organizationA = await createOrganization(
    ownerA.id,
    'Operations Gate A',
  );
  const organizationB = await createOrganization(
    ownerB.id,
    'Operations Gate B',
  );
  await addMembership(organizationA, analyst.id, 'ANALYST', ownerA.id);
  await addMembership(organizationA, viewer.id, 'VIEWER', ownerA.id);
  const ownerSession = await createSession(ownerA.id);
  const analystSession = await createSession(analyst.id);
  const viewerSession = await createSession(viewer.id);
  const basePath = `/api/v1/organizations/${organizationA}/operations`;
  const range = 'from=2026-09-01&to=2026-09-12';

  await expectStatus(
    'anonymous operations paths fail closed',
    await request(`${basePath}/overview?${range}`),
    401,
  );
  await expectStatus(
    'cross-tenant operations paths fail closed',
    await authenticatedRequest(
      `/api/v1/organizations/${organizationB}/operations/overview?${range}`,
      ownerSession,
    ),
    403,
  );
  await expectStatus(
    'viewer cannot change organization thresholds',
    await authenticatedRequest(`${basePath}/thresholds`, viewerSession, {
      body: thresholdPolicy(),
      method: 'PATCH',
    }),
    403,
  );
  await expectStatus(
    'unknown timezone is rejected predictably',
    await authenticatedRequest(`${basePath}/thresholds`, ownerSession, {
      body: { ...thresholdPolicy(), timezone: 'Mars/Olympus' },
      method: 'PATCH',
    }),
    400,
  );
  await expectStatus(
    'critical age must exceed warning age',
    await authenticatedRequest(`${basePath}/thresholds`, ownerSession, {
      body: {
        ...thresholdPolicy(),
        backlogCriticalMinutes: 60,
        backlogWarningMinutes: 60,
      },
      method: 'PATCH',
    }),
    400,
  );
  const policy = await expectJson(
    'owner can persist a validated organization policy',
    await authenticatedRequest(`${basePath}/thresholds`, ownerSession, {
      body: thresholdPolicy(),
      method: 'PATCH',
    }),
    200,
  );
  assert.equal(policy.timezone, 'America/New_York');
  assert.equal(policy.cutoffLocalTime, '17:00');

  const sourceNow = new Date().toISOString();
  const sources = [
    orderPayload('before-cutoff-late', {
      fulfilments: [fulfilment('before', '2026-09-09T16:00:00Z')],
      occurredAt: '2026-09-08T20:59:00Z',
      sourceUpdatedAt: sourceNow,
    }),
    orderPayload('after-cutoff-on-time', {
      fulfilments: [fulfilment('after', '2026-09-09T16:00:00Z')],
      occurredAt: '2026-09-08T21:01:00Z',
      sourceUpdatedAt: sourceNow,
    }),
    orderPayload('critical-backlog', {
      occurredAt: '2026-09-05T14:00:00Z',
      sourceUpdatedAt: sourceNow,
    }),
    orderPayload('cancelled', {
      occurredAt: '2026-09-09T14:00:00Z',
      sourceUpdatedAt: sourceNow,
      status: 'cancelled',
    }),
    orderPayload('returned', {
      fulfilments: [fulfilment('returned', '2026-09-09T21:00:00Z')],
      occurredAt: '2026-09-09T14:00:00Z',
      returns: [
        {
          amountMinor: 500,
          externalId: 'return-returned',
          requestedAt: '2026-09-10T18:00:00Z',
          status: 'requested',
        },
      ],
      sourceUpdatedAt: sourceNow,
    }),
  ];
  for (const source of sources) {
    await expectStatus(
      `order ${source.externalId} is accepted`,
      await authenticatedRequest(
        `/api/v1/organizations/${organizationA}/data/orders`,
        ownerSession,
        {
          body: source,
          headers: { 'idempotency-key': `operations-${source.externalId}` },
          method: 'POST',
        },
      ),
      201,
    );
  }

  const inventoryKey = `operations-inventory-${runId}`;
  const stock = inventoryPayload(sourceNow);
  const firstInventory = await expectJson(
    'real inventory snapshots are accepted',
    await authenticatedRequest(
      `/api/v1/organizations/${organizationA}/data/inventory`,
      ownerSession,
      {
        body: stock,
        headers: { 'idempotency-key': inventoryKey },
        method: 'POST',
      },
    ),
    201,
  );
  const replayInventory = await expectJson(
    'inventory delivery is idempotent',
    await authenticatedRequest(
      `/api/v1/organizations/${organizationA}/data/inventory`,
      ownerSession,
      {
        body: stock,
        headers: { 'idempotency-key': inventoryKey },
        method: 'POST',
      },
    ),
    201,
  );
  assert.deepEqual(replayInventory, firstInventory);
  await expectStatus(
    'changed inventory cannot reuse an idempotency key',
    await authenticatedRequest(
      `/api/v1/organizations/${organizationA}/data/inventory`,
      ownerSession,
      {
        body: { ...stock, onHandQuantity: 8 },
        headers: { 'idempotency-key': inventoryKey },
        method: 'POST',
      },
    ),
    409,
  );

  const overview = await expectJson(
    'viewer can read reconciled operational metrics',
    await authenticatedRequest(`${basePath}/overview?${range}`, viewerSession),
    200,
  );
  assert.equal(overview.health.status, 'healthy');
  assert.equal(overview.kpis.backlogCount, 1);
  assert.equal(overview.kpis.lowStockCount, 1);
  assert.equal(overview.kpis.stockOnHandQuantity, '7');
  assert.equal(overview.kpis.cancellationRateBasisPoints, 2_000);
  assert.equal(overview.kpis.returnRateBasisPoints, 2_500);
  assert.equal(overview.kpis.serviceLevelBasisPoints, 6_667);
  assert.ok(overview.kpis.averageFulfilmentLeadMinutes > 0);
  assert.ok(overview.alerts.some(({ type }) => type === 'backlog'));
  assert.ok(overview.alerts.some(({ type }) => type === 'late-fulfilment'));
  assert.ok(overview.alerts.some(({ type }) => type === 'low-stock'));
  assert.ok(overview.alerts.some(({ type }) => type === 'cancellation'));
  assert.ok(overview.alerts.some(({ type }) => type === 'return'));

  const lateIssues = await expectJson(
    'cutoff calculation marks only the before-cutoff shipment late',
    await authenticatedRequest(
      `${basePath}/issues?${range}&issueType=late-fulfilment&pageSize=10`,
      viewerSession,
    ),
    200,
  );
  assert.equal(lateIssues.items.length, 1);
  assert.match(lateIssues.items[0].title, /before-cutoff-late/i);

  const activeAlert = overview.alerts.find(({ type }) => type === 'backlog');
  assert.ok(activeAlert);
  await expectStatus(
    'viewer cannot acknowledge an alert',
    await authenticatedRequest(
      `${basePath}/alerts/${activeAlert.key}/acknowledgement?${range}`,
      viewerSession,
      { method: 'POST' },
    ),
    403,
  );
  await expectStatus(
    'analyst can acknowledge an active alert',
    await authenticatedRequest(
      `${basePath}/alerts/${activeAlert.key}/acknowledgement?${range}`,
      analystSession,
      { method: 'POST' },
    ),
    204,
  );
  const acknowledged = await expectJson(
    'acknowledgement state is visible to the team',
    await authenticatedRequest(`${basePath}/overview?${range}`, viewerSession),
    200,
  );
  assert.equal(
    acknowledged.alerts.find(({ key }) => key === activeAlert.key)?.status,
    'acknowledged',
  );
  await expectStatus(
    'analyst can reopen acknowledged work',
    await authenticatedRequest(
      `${basePath}/alerts/${activeAlert.key}/acknowledgement`,
      analystSession,
      { method: 'DELETE' },
    ),
    204,
  );

  const audit = await pool.query(
    `SELECT event_type FROM audit_events WHERE organization_id = $1
     AND event_type LIKE 'operations.%' ORDER BY id`,
    [organizationA],
  );
  assert.deepEqual(
    audit.rows.map(({ event_type }) => event_type),
    [
      'operations.thresholds_updated',
      'operations.alert_acknowledged',
      'operations.alert_reopened',
    ],
  );

  const pageOne = await expectJson(
    'issue results are bounded with a stable cursor',
    await authenticatedRequest(
      `${basePath}/issues?${range}&pageSize=10`,
      viewerSession,
    ),
    200,
  );
  await addCancellationFixtures(organizationA, 14);
  const paged = await expectJson(
    'large issue populations return a bounded first page',
    await authenticatedRequest(
      `${basePath}/issues?${range}&pageSize=10`,
      viewerSession,
    ),
    200,
  );
  assert.equal(paged.items.length, 10);
  assert.equal(paged.pageInfo.hasNextPage, true);
  const second = await expectJson(
    'the next issue page has no duplicate records',
    await authenticatedRequest(
      `${basePath}/issues?${range}&pageSize=10&cursor=${encodeURIComponent(paged.pageInfo.nextCursor)}`,
      viewerSession,
    ),
    200,
  );
  assert.equal(
    new Set([...paged.items, ...second.items].map(({ id }) => id)).size,
    paged.items.length + second.items.length,
  );
  await expectStatus(
    'cursor reuse under changed filters is rejected',
    await authenticatedRequest(
      `${basePath}/issues?${range}&pageSize=10&issueType=backlog&cursor=${encodeURIComponent(paged.pageInfo.nextCursor)}`,
      viewerSession,
    ),
    400,
  );
  assert.ok(pageOne.items.length > 0);

  for (const table of ['orders', 'inventory']) {
    await pool.query(
      `UPDATE ${table} SET source_updated_at = now() - interval '3 days',
         updated_at = now() - interval '3 days' WHERE organization_id = $1`,
      [organizationA],
    );
  }
  await pool.query(
    `UPDATE fulfilments SET updated_at = now() - interval '3 days'
     WHERE organization_id = $1`,
    [organizationA],
  );
  await invalidateCache(organizationA);
  const delayed = await expectJson(
    'delayed sources are distinguished from healthy data',
    await authenticatedRequest(`${basePath}/overview?${range}`, viewerSession),
    200,
  );
  assert.equal(delayed.health.status, 'delayed');
  assert.ok(delayed.health.sources.every(({ status }) => status === 'delayed'));

  await pool.query('DELETE FROM inventory WHERE organization_id = $1', [
    organizationA,
  ]);
  await invalidateCache(organizationA);
  const missing = await expectJson(
    'missing source coverage is distinguished from delayed coverage',
    await authenticatedRequest(`${basePath}/overview?${range}`, viewerSession),
    200,
  );
  assert.equal(missing.health.status, 'missing');
  assert.equal(
    missing.health.sources.find(({ source }) => source === 'inventory')?.status,
    'missing',
  );

  const empty = await expectJson(
    'a new tenant receives an explicit empty state',
    await authenticatedRequest(
      `/api/v1/organizations/${organizationB}/operations/overview?${range}`,
      await createSession(ownerB.id),
    ),
    200,
  );
  assert.equal(empty.health.status, 'empty');
  assert.equal(empty.kpis.backlogCount, 0);

  await verifyRowSecurity(organizationA, organizationB);
  const performance = await verifyLargeResultSet(ownerA.id, ownerSession);

  const specification = await expectJson(
    'operations and inventory routes are published in OpenAPI',
    await request('/api/openapi.json'),
    200,
  );
  assert.ok(
    specification.paths[
      '/api/v1/organizations/{organizationId}/operations/overview'
    ],
  );
  assert.ok(
    specification.paths[
      '/api/v1/organizations/{organizationId}/data/inventory'
    ],
  );

  console.log(
    `Operations integration gate passed: 25 authorization, policy, ingestion, cutoff, reconciliation, alert, pagination, freshness, RLS, contract, and scale checks. 50k-order issue page: ${performance.toFixed(2)} ms.`,
  );
} catch (error) {
  console.error(error);
  const diagnostics = serverOutput.join('').trim();
  if (diagnostics) console.error(diagnostics);
  throw error;
} finally {
  await cleanup();
  api.kill('SIGTERM');
  await Promise.race([onceExited(api), delay(2_000)]);
  if (api.exitCode === null) api.kill('SIGKILL');
  if (redis.isOpen) redis.destroy();
  await pool.end();
}

function thresholdPolicy() {
  return {
    backlogCriticalMinutes: 120,
    backlogWarningMinutes: 60,
    cancellationWarningBasisPoints: 1_000,
    cutoffLocalTime: '17:00',
    dataStaleAfterMinutes: 1_440,
    fulfilmentTargetMinutes: 60,
    lowStockBufferQuantity: 2,
    returnWarningBasisPoints: 500,
    timezone: 'America/New_York',
  };
}

function orderPayload(label, options) {
  return {
    channel: {
      externalId: 'operations-online',
      kind: 'storefront',
      name: 'Operations online',
    },
    currency: 'USD',
    externalId: `${label}-${runId}`,
    fulfilments: options.fulfilments ?? [],
    items: [
      {
        externalId: `line-${label}`,
        name: `Operations product ${label}`,
        productExternalId: `operations-product-${label}`,
        quantity: 1,
        sku: `OPS-${label.toUpperCase()}`,
        totalMinor: 1_000,
        unitPriceMinor: 1_000,
      },
    ],
    location: {
      countryCode: 'US',
      externalId: 'operations-east',
      kind: 'warehouse',
      name: 'East operations hub',
      timezone: 'America/New_York',
    },
    occurredAt: options.occurredAt,
    orderNumber: `OPS-${label}-${runId}`,
    payment: {
      authorizedMinor: 1_000,
      capturedMinor: options.status === 'cancelled' ? 0 : 1_000,
      status: options.status === 'cancelled' ? 'pending' : 'captured',
    },
    returns: options.returns ?? [],
    sourceUpdatedAt: options.sourceUpdatedAt,
    status: options.status ?? 'confirmed',
    subtotalMinor: 1_000,
    totalMinor: 1_000,
  };
}

function fulfilment(label, shippedAt) {
  return {
    externalId: `fulfilment-${label}`,
    locationExternalId: 'operations-east',
    shippedAt,
    status: 'shipped',
  };
}

function inventoryPayload(sourceUpdatedAt) {
  return {
    location: {
      countryCode: 'US',
      externalId: 'operations-east',
      kind: 'warehouse',
      name: 'East operations hub',
      timezone: 'America/New_York',
    },
    onHandQuantity: 7,
    product: {
      externalId: 'operations-stock-item',
      name: 'Operations stock item',
      sku: 'OPS-STOCK-1',
    },
    reorderPoint: 5,
    reservedQuantity: 1,
    sourceUpdatedAt,
  };
}

async function addCancellationFixtures(organizationId, count) {
  const channel = await pool.query(
    `SELECT id FROM channels WHERE organization_id = $1 AND external_id = 'operations-online'`,
    [organizationId],
  );
  const location = await pool.query(
    `SELECT id FROM locations WHERE organization_id = $1 AND external_id = 'operations-east'`,
    [organizationId],
  );
  await pool.query(
    `INSERT INTO orders (
       organization_id, channel_id, location_id, external_id, order_number,
       status, currency, subtotal_minor, total_minor, occurred_at, source_updated_at
     ) SELECT $1, $2, $3, 'ops-page-' || value || $4,
       'OPS-PAGE-' || value || $4, 'cancelled', 'USD', 1000, 1000,
       '2026-09-10T10:00:00Z'::timestamptz + value * interval '1 minute', now()
     FROM generate_series(1, $5) value`,
    [organizationId, channel.rows[0].id, location.rows[0].id, runId, count],
  );
}

async function verifyRowSecurity(organizationA, organizationB) {
  const role = `phase6_rls_${runId}`;
  const client = await pool.connect();
  try {
    await client.query(`CREATE ROLE ${role} NOLOGIN`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await client.query(
      `GRANT SELECT ON operations_thresholds, operations_alert_acknowledgements TO ${role}`,
    );
    await client.query(`SET ROLE ${role}`);
    const hidden = await client.query(
      'SELECT count(*)::int AS count FROM operations_thresholds',
    );
    assert.equal(hidden.rows[0].count, 0);
    await client.query("SELECT set_config('app.organization_id', $1, false)", [
      organizationA,
    ]);
    const visible = await client.query(
      'SELECT organization_id FROM operations_thresholds',
    );
    assert.ok(visible.rows.length > 0);
    assert.ok(
      visible.rows.every(
        ({ organization_id }) => organization_id === organizationA,
      ),
    );
    assert.ok(
      visible.rows.every(
        ({ organization_id }) => organization_id !== organizationB,
      ),
    );
  } finally {
    try {
      await client.query('RESET ROLE');
      await client.query(`DROP OWNED BY ${role}`);
      await client.query(`DROP ROLE IF EXISTS ${role}`);
    } catch {
      // Cleanup must not mask an assertion failure.
    }
    client.release();
  }
}

async function verifyLargeResultSet(ownerId, ownerSession) {
  const organizationId = await createOrganization(ownerId, 'Operations Scale');
  const channel = await pool.query(
    `INSERT INTO channels (organization_id, external_id, name, kind)
     VALUES ($1, 'scale', 'Scale feed', 'storefront') RETURNING id`,
    [organizationId],
  );
  const location = await pool.query(
    `INSERT INTO locations (organization_id, external_id, name, timezone)
     VALUES ($1, 'scale', 'Scale hub', 'UTC') RETURNING id`,
    [organizationId],
  );
  await pool.query(
    `INSERT INTO orders (
       organization_id, channel_id, location_id, external_id, order_number,
       status, currency, subtotal_minor, total_minor, occurred_at, source_updated_at
     ) SELECT $1, $2, $3, 'scale-' || value, 'SCALE-' || value,
       'confirmed', 'USD', 1000, 1000, now() - value * interval '1 minute', now()
     FROM generate_series(1, 50000) value`,
    [organizationId, channel.rows[0].id, location.rows[0].id],
  );
  await pool.query('ANALYZE orders');
  const from = new Date(Date.now() - 31 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const to = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const started = performance.now();
  const response = await authenticatedRequest(
    `/api/v1/organizations/${organizationId}/operations/issues?from=${from}&to=${to}&issueType=backlog&pageSize=10`,
    ownerSession,
  );
  const elapsed = performance.now() - started;
  const page = await expectJson(
    '50k-order issue page remains bounded',
    response,
    200,
  );
  assert.equal(page.items.length, 10);
  assert.equal(page.pageInfo.hasNextPage, true);
  assert.ok(
    elapsed < 2_000,
    `50k-order issue page took ${elapsed.toFixed(2)} ms`,
  );
  return elapsed;
}

async function createUser(label) {
  const result = await pool.query(
    `INSERT INTO identity_users (issuer, subject, email, display_name)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [
      `urn:analytics-admin:operations:${runId}`,
      `${label}-${runId}`,
      `${label.toLowerCase().replaceAll(' ', '.')}+${runId}@integration.test`,
      label,
    ],
  );
  const user = result.rows[0];
  assert.ok(user);
  userIds.push(user.id);
  return user;
}

async function createOrganization(userId, label) {
  const result = await pool.query(
    `INSERT INTO organizations (slug, name, created_by_user_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [`${label.toLowerCase().replaceAll(' ', '-')}-${runId}`, label, userId],
  );
  const organization = result.rows[0];
  assert.ok(organization);
  organizationIds.push(organization.id);
  await addMembership(organization.id, userId, 'OWNER', userId);
  return organization.id;
}

function addMembership(organizationId, userId, role, actorId) {
  return pool.query(
    `INSERT INTO organization_memberships (
       organization_id, user_id, role, created_by_user_id
     ) VALUES ($1, $2, $3, $4)`,
    [organizationId, userId, role, actorId],
  );
}

async function createSession(userId) {
  const token = randomBytes(32).toString('base64url');
  const csrf = randomBytes(32).toString('base64url');
  const now = Math.floor(Date.now() / 1_000);
  const key = sessionKey(token);
  await redis.set(
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
  await redis.sAdd(userSessionsKey(userId), key);
  await redis.expire(userSessionsKey(userId), 28_800);
  sessionTokens.push(token);
  return { csrf, token };
}

function authenticatedRequest(path, session, options = {}) {
  return request(path, {
    ...options,
    csrf: session.csrf,
    token: session.token,
  });
}

async function request(path, options = {}) {
  const headers = { accept: 'application/json', ...options.headers };
  if (options.token) headers.cookie = `aad_session=${options.token}`;
  if (options.csrf) headers['x-csrf-token'] = options.csrf;
  if (options.method && options.method !== 'GET' && options.token) {
    headers.origin = webOrigin;
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

async function waitForApi() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (api.exitCode !== null) {
      throw new Error(`Operations API exited early: ${api.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/v1/health/ready`);
      if (response.ok) return;
    } catch {
      // Startup is still in progress.
    }
    await delay(150);
  }
  throw new Error('Operations API did not become ready within 15 seconds');
}

async function cleanup() {
  if (redis.isOpen) {
    if (sessionTokens.length) await redis.del(sessionTokens.map(sessionKey));
    if (userIds.length) await redis.del(userIds.map(userSessionsKey));
  }
  if (organizationIds.length) {
    await pool.query(
      'DELETE FROM audit_events WHERE organization_id = ANY($1::uuid[])',
      [organizationIds],
    );
    await pool.query('DELETE FROM organizations WHERE id = ANY($1::uuid[])', [
      organizationIds,
    ]);
  }
  if (userIds.length) {
    await pool.query('DELETE FROM identity_users WHERE id = ANY($1::uuid[])', [
      userIds,
    ]);
  }
}

function invalidateCache(organizationId) {
  return redis.incr(`resilience:cache-generation:${organizationId}`);
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
    throw new Error(`${name} is required for Operations integration tests`);
  return value;
}

function onceExited(child) {
  return new Promise((resolve) => child.once('exit', resolve));
}
