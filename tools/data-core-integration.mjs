import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { Pool } from 'pg';
import { createClient } from 'redis';

const require = createRequire(import.meta.url);
const { migrations } = require('../dist/libs/data-core/src/lib/migrations.js');
const databaseUrl = requiredEnvironment('DATABASE_URL');
const redisUrl = requiredEnvironment('REDIS_URL');
const signingKey = requiredEnvironment('WEBHOOK_SIGNING_KEY');
const port = 32_000 + Math.floor(Math.random() * 1_000);
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
  APP_VERSION: 'data-core-integration',
  IMPORT_POLL_MS: '500',
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
const worker = spawn(process.execPath, ['dist/apps/worker/main.js'], {
  cwd: process.cwd(),
  env: childEnvironment,
  stdio: ['ignore', 'pipe', 'pipe'],
});

for (const process of [api, worker]) {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('data', (chunk) => {
      serverOutput.push(String(chunk));
      if (serverOutput.length > 50) serverOutput.shift();
    });
  }
}

try {
  await redis.connect();
  await waitForApi();

  const ownerA = await createUser('Data Owner A');
  const ownerB = await createUser('Data Owner B');
  const organizationA = await createOrganization(ownerA.id, 'Data Core A');
  const organizationB = await createOrganization(ownerB.id, 'Data Core B');
  const sessionA = await createSession(ownerA.id);
  const sessionB = await createSession(ownerB.id);
  const orderA = orderPayload(`rest-${runId}`);

  await expectStatus(
    'anonymous REST ingestion fails closed',
    await request(`/api/v1/organizations/${organizationA}/data/orders`, {
      body: orderA,
      headers: { 'idempotency-key': `anonymous-${runId}` },
      method: 'POST',
    }),
    401,
  );
  await expectStatus(
    'cross-tenant REST ingestion fails closed',
    await authenticatedRequest(
      `/api/v1/organizations/${organizationB}/data/orders`,
      sessionA,
      {
        body: orderA,
        headers: { 'idempotency-key': `cross-${runId}` },
        method: 'POST',
      },
    ),
    403,
  );
  await expectStatus(
    'unknown REST fields are rejected before persistence',
    await authenticatedRequest(
      `/api/v1/organizations/${organizationA}/data/orders`,
      sessionA,
      {
        body: { ...orderA, unsupported: true },
        headers: { 'idempotency-key': `unknown-field-${runId}` },
        method: 'POST',
      },
    ),
    400,
  );
  await assertOrderCount(organizationA, orderA.externalId, 0, 0);

  const first = await expectJson(
    'REST order is accepted',
    await authenticatedRequest(
      `/api/v1/organizations/${organizationA}/data/orders`,
      sessionA,
      {
        body: orderA,
        headers: { 'idempotency-key': `rest-order-${runId}` },
        method: 'POST',
      },
    ),
    201,
  );
  const replay = await expectJson(
    'same REST delivery returns the persisted response',
    await authenticatedRequest(
      `/api/v1/organizations/${organizationA}/data/orders`,
      sessionA,
      {
        body: orderA,
        headers: { 'idempotency-key': `rest-order-${runId}` },
        method: 'POST',
      },
    ),
    201,
  );
  assert.deepEqual(replay, first);
  await assertOrderCount(organizationA, orderA.externalId, 1, 2);

  await expectStatus(
    'idempotency key reuse with changed content is rejected',
    await authenticatedRequest(
      `/api/v1/organizations/${organizationA}/data/orders`,
      sessionA,
      {
        body: { ...orderA, orderNumber: `${orderA.orderNumber}-changed` },
        headers: { 'idempotency-key': `rest-order-${runId}` },
        method: 'POST',
      },
    ),
    409,
  );
  const sourceReplay = await expectJson(
    'same source order with a new delivery key updates instead of duplicating',
    await authenticatedRequest(
      `/api/v1/organizations/${organizationA}/data/orders`,
      sessionA,
      {
        body: orderA,
        headers: { 'idempotency-key': `rest-order-new-${runId}` },
        method: 'POST',
      },
    ),
    201,
  );
  assert.equal(sourceReplay.orderId, first.orderId);
  await assertOrderCount(organizationA, orderA.externalId, 1, 2);

  await authenticatedRequest(
    `/api/v1/organizations/${organizationB}/data/orders`,
    sessionB,
    {
      body: orderPayload(`tenant-b-${runId}`),
      headers: { 'idempotency-key': `tenant-b-${runId}` },
      method: 'POST',
    },
  ).then((response) =>
    expectStatus('second tenant owns an isolated order', response, 201),
  );

  const endpoint = await expectJson(
    'manager creates a write-only webhook secret',
    await authenticatedRequest(
      `/api/v1/organizations/${organizationA}/data/webhooks`,
      sessionA,
      { body: { name: 'Primary commerce feed' }, method: 'POST' },
    ),
    201,
  );
  assert.match(endpoint.secret, /^[A-Za-z0-9_-]{43}$/);
  const webhookOrder = orderPayload(`webhook-${runId}`);
  const webhookBody = JSON.stringify(webhookOrder);
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const signature = webhookSignature(endpoint.secret, timestamp, webhookBody);
  const webhookPath = `/api/v1/organizations/${organizationA}/webhooks/orders/${endpoint.id}`;

  await expectStatus(
    'tampered webhook signature is rejected',
    await request(webhookPath, {
      bodyText: webhookBody,
      headers: webhookHeaders(
        timestamp,
        `bad-event-${runId}`,
        `v1=${'0'.repeat(64)}`,
      ),
      method: 'POST',
    }),
    401,
  );
  await assertOrderCount(organizationA, webhookOrder.externalId, 0, 0);

  const webhookFirst = await expectJson(
    'valid signed webhook is accepted',
    await request(webhookPath, {
      bodyText: webhookBody,
      headers: webhookHeaders(timestamp, `webhook-event-${runId}`, signature),
      method: 'POST',
    }),
    201,
  );
  const webhookReplay = await expectJson(
    'duplicate signed webhook is idempotent',
    await request(webhookPath, {
      bodyText: webhookBody,
      headers: webhookHeaders(timestamp, `webhook-event-${runId}`, signature),
      method: 'POST',
    }),
    201,
  );
  assert.deepEqual(webhookReplay, webhookFirst);
  await assertOrderCount(organizationA, webhookOrder.externalId, 1, 2);

  const invalidCsv = orderCsv([
    csvRow(`csv-valid-${runId}`, '500', '500'),
    csvRow(`csv-invalid-${runId}`, '500', '499'),
  ]);
  const invalidImport = await expectJson(
    'mixed-validity CSV is queued',
    await csvRequest(organizationA, sessionA, invalidCsv, `invalid-${runId}`),
    202,
  );
  const failedImport = await waitForImport(
    organizationA,
    sessionA,
    invalidImport.id,
  );
  assert.equal(failedImport.status, 'failed');
  assert.equal(failedImport.acceptedRows, 0);
  assert.ok(failedImport.errorReport.length > 0);
  await assertOrderCount(organizationA, `csv-valid-${runId}`, 0, 0);

  const validCsv = orderCsv([csvRow(`csv-complete-${runId}`, '750', '750')]);
  const validImport = await expectJson(
    'valid CSV is queued',
    await csvRequest(organizationA, sessionA, validCsv, `valid-${runId}`),
    202,
  );
  const repeatedImport = await expectJson(
    'same CSV import key returns the existing job',
    await csvRequest(organizationA, sessionA, validCsv, `valid-${runId}`),
    202,
  );
  assert.equal(repeatedImport.id, validImport.id);
  const completedImport = await waitForImport(
    organizationA,
    sessionA,
    validImport.id,
  );
  assert.equal(completedImport.status, 'completed');
  assert.equal(completedImport.acceptedRows, 1);
  await assertOrderCount(organizationA, `csv-complete-${runId}`, 1, 1);

  const exhaustedImportId = await createExhaustedImport(
    organizationA,
    ownerA.id,
    validCsv,
  );
  const exhaustedImport = await waitForImport(
    organizationA,
    sessionA,
    exhaustedImportId,
  );
  assert.equal(exhaustedImport.status, 'failed');
  assert.match(
    exhaustedImport.errorReport[0]?.message ?? '',
    /repeated worker interruptions/,
  );

  await verifyRowSecurity(organizationA, organizationB);
  await verifyReversibleMigration();

  const specification = await expectJson(
    'versioned OpenAPI document is available',
    await request('/api/openapi.json'),
    200,
  );
  assert.ok(
    specification.paths['/api/v1/organizations/{organizationId}/data/orders'],
  );
  assert.ok(
    specification.paths[
      '/api/v1/organizations/{organizationId}/webhooks/orders/{endpointId}'
    ],
  );

  console.log(
    'Data Core integration gate passed: 21 ingestion, atomicity, tenant, and migration checks.',
  );
} catch (error) {
  const diagnostics = serverOutput.join('').trim();
  if (diagnostics) console.error(diagnostics);
  throw error;
} finally {
  await cleanup();
  for (const process of [api, worker]) process.kill('SIGTERM');
  await Promise.all(
    [onceExited(api), onceExited(worker)].map((exit) =>
      Promise.race([exit, delay(2_000)]),
    ),
  );
  for (const process of [api, worker]) {
    if (process.exitCode === null) process.kill('SIGKILL');
  }
  if (redis.isOpen) await redis.quit();
  await pool.end();
}

function orderPayload(externalId) {
  return {
    channel: {
      externalId: 'online-store',
      kind: 'storefront',
      name: 'Online Store',
    },
    currency: 'USD',
    customerReference: { externalId: `customer-${externalId}` },
    discountMinor: 100,
    externalId,
    fulfilments: [],
    items: [
      {
        externalId: 'line-1',
        name: 'Travel Backpack',
        productExternalId: 'product-backpack',
        quantity: 1,
        sku: 'BAG-TRAVEL-01',
        totalMinor: 7_500,
        unitPriceMinor: 7_500,
      },
      {
        externalId: 'line-2',
        name: 'Packing Cubes',
        productExternalId: 'product-cubes',
        quantity: 1,
        sku: 'BAG-CUBES-01',
        totalMinor: 2_500,
        unitPriceMinor: 2_500,
      },
    ],
    location: {
      countryCode: 'US',
      externalId: 'warehouse-east',
      kind: 'warehouse',
      name: 'East Warehouse',
      timezone: 'America/New_York',
    },
    occurredAt: '2026-09-03T10:30:00Z',
    orderNumber: `ORDER-${externalId}`,
    payment: {
      authorizedMinor: 10_700,
      capturedMinor: 10_700,
      refundedMinor: 0,
      status: 'captured',
    },
    returns: [],
    shippingMinor: 500,
    status: 'confirmed',
    subtotalMinor: 10_000,
    taxMinor: 300,
    totalMinor: 10_700,
  };
}

function csvRow(externalId, subtotal, itemTotal) {
  return [
    externalId,
    `ORDER-${externalId}`,
    'confirmed',
    'USD',
    '2026-09-03T10:30:00Z',
    'csv-store',
    'CSV Store',
    'storefront',
    `line-${externalId}`,
    `product-${externalId}`,
    `SKU-${externalId}`,
    'Imported Product',
    '1',
    subtotal,
    itemTotal,
    subtotal,
    subtotal,
  ].join(',');
}

function orderCsv(rows) {
  return [
    [
      'order_external_id',
      'order_number',
      'order_status',
      'currency',
      'occurred_at',
      'channel_external_id',
      'channel_name',
      'channel_kind',
      'item_external_id',
      'product_external_id',
      'sku',
      'product_name',
      'quantity',
      'unit_price_minor',
      'item_total_minor',
      'order_subtotal_minor',
      'order_total_minor',
    ].join(','),
    ...rows,
  ].join('\n');
}

async function createUser(label) {
  const result = await pool.query(
    `
      INSERT INTO identity_users (issuer, subject, email, display_name)
      VALUES ($1, $2, $3, $4)
      RETURNING id
    `,
    [
      `urn:analytics-admin:data-core:${runId}`,
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
    `
      INSERT INTO organizations (slug, name, created_by_user_id)
      VALUES ($1, $2, $3)
      RETURNING id
    `,
    [`${label.toLowerCase().replaceAll(' ', '-')}-${runId}`, label, userId],
  );
  const organization = result.rows[0];
  assert.ok(organization);
  organizationIds.push(organization.id);
  await pool.query(
    `
      INSERT INTO organization_memberships (
        organization_id, user_id, role, created_by_user_id
      ) VALUES ($1, $2, 'OWNER', $2)
    `,
    [organization.id, userId],
  );
  return organization.id;
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

function csvRequest(organizationId, session, csv, idempotencyKey) {
  return authenticatedRequest(
    `/api/v1/organizations/${organizationId}/data/imports/orders`,
    session,
    {
      bodyText: csv,
      headers: {
        'content-type': 'text/csv',
        'idempotency-key': idempotencyKey,
        'x-import-filename': 'orders.csv',
      },
      method: 'POST',
    },
  );
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
    body:
      options.bodyText ??
      (options.body === undefined ? undefined : JSON.stringify(options.body)),
    headers,
    method: options.method ?? 'GET',
    redirect: 'manual',
  });
}

async function waitForImport(organizationId, session, importId) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const job = await expectJson(
      'import status is readable',
      await authenticatedRequest(
        `/api/v1/organizations/${organizationId}/data/imports/${importId}`,
        session,
      ),
      200,
    );
    if (job.status === 'completed' || job.status === 'failed') return job;
    await delay(100);
  }
  throw new Error(`Import ${importId} did not finish within 10 seconds`);
}

async function assertOrderCount(organizationId, externalId, orders, items) {
  const result = await pool.query(
    `
      SELECT
        count(DISTINCT order_record.id)::int AS orders,
        count(item.id)::int AS items
      FROM orders order_record
      LEFT JOIN order_items item ON item.order_id = order_record.id
      WHERE order_record.organization_id = $1 AND order_record.external_id = $2
    `,
    [organizationId, externalId],
  );
  assert.deepEqual(result.rows[0], { items, orders });
}

async function createExhaustedImport(organizationId, userId, csv) {
  const result = await pool.query(
    `
      INSERT INTO data_imports (
        organization_id, requested_by_user_id, idempotency_key, filename,
        content_sha256, csv_payload, status, attempts, processing_started_at
      ) VALUES (
        $1, $2, $3, 'orders.csv', $4, $5, 'processing', 5,
        now() - interval '10 minutes'
      )
      RETURNING id
    `,
    [
      organizationId,
      userId,
      `exhausted-${runId}`,
      createHash('sha256').update(csv).digest('hex'),
      csv,
    ],
  );
  assert.ok(result.rows[0]?.id);
  return result.rows[0].id;
}

async function verifyRowSecurity(organizationA, organizationB) {
  const role = `phase3_rls_${runId}`;
  const client = await pool.connect();
  try {
    await client.query(`CREATE ROLE ${role} NOLOGIN`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await client.query(`GRANT SELECT ON orders TO ${role}`);
    await client.query(`SET ROLE ${role}`);
    const hidden = await client.query(
      'SELECT count(*)::int AS count FROM orders',
    );
    assert.equal(hidden.rows[0].count, 0);
    await client.query("SELECT set_config('app.organization_id', $1, false)", [
      organizationA,
    ]);
    const visible = await client.query(
      'SELECT DISTINCT organization_id FROM orders ORDER BY organization_id',
    );
    assert.ok(visible.rows.length > 0);
    assert.ok(
      visible.rows.every((row) => row.organization_id === organizationA),
    );
    assert.ok(
      visible.rows.every((row) => row.organization_id !== organizationB),
    );
    await client.query('RESET ROLE');
    await client.query(`DROP OWNED BY ${role}`);
    await client.query(`DROP ROLE ${role}`);
  } finally {
    try {
      await client.query('RESET ROLE');
      await client.query(`DROP OWNED BY ${role}`);
      await client.query(`DROP ROLE IF EXISTS ${role}`);
    } catch {
      // The cleanup path must not mask the primary assertion.
    }
    client.release();
  }
}

async function verifyReversibleMigration() {
  const schema = `phase3_migration_${runId}`;
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    for (const migration of migrations) await client.query(migration.up);
    assert.equal(await tableExists(client, schema, 'orders'), true);
    for (const migration of migrations.slice(2).reverse()) {
      await client.query(migration.down);
    }
    await client.query(migrations[1].down);
    assert.equal(await tableExists(client, schema, 'orders'), false);
    await client.query(migrations[1].up);
    for (const migration of migrations.slice(2)) {
      await client.query(migration.up);
    }
    assert.equal(await tableExists(client, schema, 'orders'), true);
  } finally {
    await client.query('RESET search_path');
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    client.release();
  }
}

async function tableExists(client, schema, table) {
  const result = await client.query(
    'SELECT to_regclass($1) IS NOT NULL AS exists',
    [`${schema}.${table}`],
  );
  return result.rows[0].exists;
}

function webhookHeaders(timestamp, eventId, signature) {
  return {
    'content-type': 'application/json',
    'x-webhook-event-id': eventId,
    'x-webhook-signature': signature,
    'x-webhook-timestamp': timestamp,
  };
}

function webhookSignature(secret, timestamp, body) {
  return `v1=${createHmac('sha256', Buffer.from(secret, 'base64url'))
    .update(`${timestamp}.${body}`)
    .digest('hex')}`;
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
    if (api.exitCode !== null || worker.exitCode !== null) {
      throw new Error(
        `Data Core process exited early: API ${api.exitCode}, worker ${worker.exitCode}`,
      );
    }
    try {
      const response = await fetch(`${baseUrl}/api/v1/health/ready`);
      if (response.ok) return;
    } catch {
      // Startup is still in progress.
    }
    await delay(150);
  }
  throw new Error('Data Core API did not become ready within 15 seconds');
}

async function cleanup() {
  if (redis.isOpen) {
    await redis.del(sessionTokens.map(sessionKey));
    await redis.del(userIds.map(userSessionsKey));
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

function sessionKey(token) {
  return `identity:session:${createHash('sha256').update(token).digest('hex')}`;
}

function userSessionsKey(userId) {
  return `identity:user-sessions:${userId}`;
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value)
    throw new Error(`${name} is required for Data Core integration tests`);
  return value;
}

function onceExited(child) {
  return new Promise((resolve) => child.once('exit', resolve));
}
