import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createClient } from 'redis';

const databaseUrl = requiredEnvironment('DATABASE_URL');
const redisUrl = requiredEnvironment('REDIS_URL');
const port = 33_000 + Math.floor(Math.random() * 1_000);
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
  APP_VERSION: 'sales-integration',
  NODE_ENV: 'test',
  OIDC_CLIENT_ID: '',
  OIDC_CLIENT_SECRET: '',
  OIDC_ISSUER_URL: '',
  OIDC_REDIRECT_URI: '',
  SALES_EXPORT_POLL_MS: '500',
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

  const ownerA = await createUser('Sales Owner A');
  const ownerB = await createUser('Sales Owner B');
  const viewer = await createUser('Sales Viewer');
  const organizationA = await createOrganization(ownerA.id, 'Sales Gate A');
  const organizationB = await createOrganization(ownerB.id, 'Sales Gate B');
  await addMembership(organizationA, viewer.id, 'VIEWER', ownerA.id);
  const ownerSession = await createSession(ownerA.id);
  const viewerSession = await createSession(viewer.id);

  await expectStatus(
    'anonymous sales analytics fails closed',
    await request(`/api/v1/organizations/${organizationA}/sales/overview`),
    401,
  );
  await expectStatus(
    'cross-tenant analytics fails closed',
    await authenticatedRequest(
      `/api/v1/organizations/${organizationB}/sales/overview`,
      ownerSession,
    ),
    403,
  );

  const sources = [
    orderPayload('primary', {
      occurredAt: '2026-09-05T10:00:00Z',
      quantity: 2,
      totalMinor: 10_000,
    }),
    orderPayload('refunded', {
      channel: 'pos',
      location: 'west',
      occurredAt: '2026-09-06T10:00:00Z',
      refundedMinor: 1_000,
      status: 'fulfilled',
      totalMinor: 6_000,
    }),
    orderPayload('cancelled', {
      occurredAt: '2026-09-07T10:00:00Z',
      status: 'cancelled',
      totalMinor: 9_000,
    }),
    orderPayload('previous', {
      occurredAt: '2026-08-29T10:00:00Z',
      totalMinor: 5_000,
    }),
    orderPayload('euro', {
      currency: 'EUR',
      occurredAt: '2026-09-08T10:00:00Z',
      totalMinor: 4_000,
    }),
    ...Array.from({ length: 12 }, (_, index) =>
      orderPayload(`page-${index + 1}`, {
        occurredAt: `2026-09-${String((index % 8) + 1).padStart(2, '0')}T12:00:00Z`,
        totalMinor: 1_000 + index * 100,
      }),
    ),
  ];
  for (const source of sources) {
    await expectStatus(
      `source order ${source.externalId} is ingested`,
      await authenticatedRequest(
        `/api/v1/organizations/${organizationA}/data/orders`,
        ownerSession,
        {
          body: source,
          headers: { 'idempotency-key': `sales-${source.externalId}` },
          method: 'POST',
        },
      ),
      201,
    );
  }

  const baseFilters = new URLSearchParams({
    currency: 'USD',
    from: '2026-09-01',
    to: '2026-09-10',
  });
  const basePath = `/api/v1/organizations/${organizationA}/sales`;

  await expectStatus(
    'mixed-currency money requires an explicit currency',
    await authenticatedRequest(
      `${basePath}/overview?from=2026-09-01&to=2026-09-10`,
      ownerSession,
    ),
    400,
  );
  const overview = await expectJson(
    'viewer can read tenant sales analytics',
    await authenticatedRequest(
      `${basePath}/overview?${baseFilters}`,
      viewerSession,
    ),
    200,
  );
  const sourceTotals = await sourceMetrics(organizationA);
  assert.equal(overview.kpis.revenueMinor.current, sourceTotals.revenueMinor);
  assert.equal(overview.kpis.orderCount.current, sourceTotals.orderCount);
  assert.equal(overview.kpis.itemsSold.current, sourceTotals.itemsSold);
  assert.equal(
    overview.kpis.averageOrderValueMinor.current,
    sourceTotals.averageOrderValueMinor,
  );
  assert.equal(overview.kpis.revenueMinor.previous, '5000');
  assert.equal(
    overview.trend.reduce(
      (total, point) => total + BigInt(point.revenueMinor),
      0n,
    ),
    BigInt(sourceTotals.revenueMinor),
  );
  assert.equal(
    overview.trend.reduce((total, point) => total + point.orderCount, 0),
    Number(sourceTotals.orderCount),
  );
  assert.ok(
    overview.trend.every(
      (point) => point.orderCount > 0 || point.averageOrderValueMinor === '0',
    ),
  );
  for (const dimension of ['channels', 'locations']) {
    assert.equal(
      overview[dimension].reduce(
        (total, segment) => total + BigInt(segment.revenueMinor),
        0n,
      ),
      BigInt(sourceTotals.revenueMinor),
    );
  }
  assert.equal(overview.freshness.status, 'fresh');
  assert.equal(overview.definitions.length, 4);
  assert.equal(overview.products.length, 8);
  assert.ok(
    overview.products.reduce(
      (total, product) => total + product.shareBasisPoints,
      0,
    ) < 10_000,
    'top product shares must use all matching products as the denominator',
  );

  const options = await expectJson(
    'filter options come from source dimensions',
    await authenticatedRequest(`${basePath}/filter-options`, viewerSession),
    200,
  );
  assert.deepEqual(options.currencies, ['EUR', 'USD']);
  assert.ok(options.channels.some(({ label }) => label === 'Point of sale'));
  assert.ok(options.products.some(({ sku }) => sku.startsWith('SKU-')));

  const confirmedFilters = new URLSearchParams(baseFilters);
  confirmedFilters.set('status', 'confirmed');
  const confirmedOverview = await expectJson(
    'status filter updates aggregate cards',
    await authenticatedRequest(
      `${basePath}/overview?${confirmedFilters}`,
      viewerSession,
    ),
    200,
  );
  const confirmedOrders = await expectJson(
    'same status filter updates source rows',
    await authenticatedRequest(
      `${basePath}/orders?${confirmedFilters}&pageSize=100`,
      viewerSession,
    ),
    200,
  );
  assert.equal(
    confirmedOrders.items.reduce(
      (total, order) => total + BigInt(order.netRevenueMinor),
      0n,
    ),
    BigInt(confirmedOverview.kpis.revenueMinor.current),
  );
  assert.ok(
    confirmedOrders.items.every(({ status }) => status === 'confirmed'),
  );

  const firstPage = await expectJson(
    'keyset order page is returned',
    await authenticatedRequest(
      `${basePath}/orders?${baseFilters}&pageSize=10`,
      viewerSession,
    ),
    200,
  );
  assert.equal(firstPage.items.length, 10);
  assert.equal(firstPage.pageInfo.hasNextPage, true);
  const secondPageParameters = new URLSearchParams(baseFilters);
  secondPageParameters.set('pageSize', '10');
  secondPageParameters.set('cursor', firstPage.pageInfo.nextCursor);
  const secondPage = await expectJson(
    'next keyset page has no duplicate rows',
    await authenticatedRequest(
      `${basePath}/orders?${secondPageParameters}`,
      viewerSession,
    ),
    200,
  );
  assert.equal(
    new Set([...firstPage.items, ...secondPage.items].map(({ id }) => id)).size,
    firstPage.items.length + secondPage.items.length,
  );
  secondPageParameters.set('status', 'fulfilled');
  await expectStatus(
    'cursor reuse under changed filters is rejected',
    await authenticatedRequest(
      `${basePath}/orders?${secondPageParameters}`,
      viewerSession,
    ),
    400,
  );

  const refunded = [...firstPage.items, ...secondPage.items].find(
    ({ orderNumber }) => orderNumber.includes('refunded'),
  );
  assert.ok(refunded);
  const detail = await expectJson(
    'order drill-down returns source financials and lines',
    await authenticatedRequest(
      `${basePath}/orders/${refunded.id}`,
      viewerSession,
    ),
    200,
  );
  assert.equal(detail.totalMinor, '6000');
  assert.equal(detail.refundedMinor, '1000');
  assert.equal(detail.netRevenueMinor, '5000');
  assert.equal(detail.items.length, 1);

  const exportBody = {
    currency: 'USD',
    direction: 'desc',
    from: '2026-09-01',
    sort: 'occurredAt',
    to: '2026-09-10',
  };
  const exportKey = `sales-export-${runId}`;
  const exportJob = await expectJson(
    'filtered CSV export is durably queued',
    await authenticatedRequest(`${basePath}/exports`, ownerSession, {
      body: exportBody,
      headers: { 'idempotency-key': exportKey },
      method: 'POST',
    }),
    202,
  );
  const replay = await expectJson(
    'same export delivery is idempotent',
    await authenticatedRequest(`${basePath}/exports`, ownerSession, {
      body: exportBody,
      headers: { 'idempotency-key': exportKey },
      method: 'POST',
    }),
    202,
  );
  assert.equal(replay.id, exportJob.id);
  await expectStatus(
    'changed export cannot reuse an idempotency key',
    await authenticatedRequest(`${basePath}/exports`, ownerSession, {
      body: { ...exportBody, status: 'fulfilled' },
      headers: { 'idempotency-key': exportKey },
      method: 'POST',
    }),
    409,
  );
  await expectStatus(
    'another tenant member cannot read a user export',
    await authenticatedRequest(
      `${basePath}/exports/${exportJob.id}`,
      viewerSession,
    ),
    404,
  );
  const completed = await waitForExport(basePath, ownerSession, exportJob.id);
  assert.equal(completed.status, 'completed');
  const csv = await expectStatus(
    'completed export downloads as CSV',
    await authenticatedRequest(
      `${basePath}/exports/${exportJob.id}/download`,
      ownerSession,
    ),
    200,
  );
  assert.equal(csv.trim().split('\n').length - 1, completed.rowCount);
  assert.equal(
    completed.rowCount,
    firstPage.items.length + secondPage.items.length,
  );
  const audit = await pool.query(
    `SELECT count(*)::int AS count FROM audit_events
     WHERE organization_id = $1 AND event_type = 'sales.export_requested'
       AND target_id = $2`,
    [organizationA, exportJob.id],
  );
  assert.equal(audit.rows[0]?.count, 1);

  const partialImportId = await createActiveImport(organizationA, ownerA.id);
  await invalidateCache(organizationA);
  const partial = await expectJson(
    'active imports produce an explicit partial state',
    await authenticatedRequest(
      `${basePath}/overview?${baseFilters}`,
      viewerSession,
    ),
    200,
  );
  assert.equal(partial.freshness.status, 'partial');
  await pool.query('DELETE FROM data_imports WHERE id = $1', [partialImportId]);

  await pool.query(
    `UPDATE orders SET updated_at = now() - interval '2 days'
     WHERE organization_id = $1`,
    [organizationA],
  );
  await invalidateCache(organizationA);
  const stale = await expectJson(
    'outdated source records produce an explicit stale state',
    await authenticatedRequest(
      `${basePath}/overview?${baseFilters}`,
      viewerSession,
    ),
    200,
  );
  assert.equal(stale.freshness.status, 'stale');

  const empty = await expectJson(
    'empty tenants return stable zero metrics',
    await authenticatedRequest(
      `/api/v1/organizations/${organizationB}/sales/overview?from=2026-09-01&to=2026-09-10`,
      await createSession(ownerB.id),
    ),
    200,
  );
  assert.equal(empty.freshness.status, 'empty');
  assert.equal(empty.kpis.revenueMinor.current, '0');

  await verifyRowSecurity(organizationA, organizationB);
  const performance = await verifyQueryPlan(ownerA.id);

  const specification = await expectJson(
    'sales routes are published in OpenAPI',
    await request('/api/openapi.json'),
    200,
  );
  assert.ok(
    specification.paths[
      '/api/v1/organizations/{organizationId}/sales/overview'
    ],
  );
  assert.ok(
    specification.paths['/api/v1/organizations/{organizationId}/sales/exports'],
  );

  console.log(
    `Sales integration gate passed: 23 authorization, reconciliation, filtering, pagination, export, state, RLS, contract, and performance checks. 100k-order query: ${performance.executionMs.toFixed(2)} ms via ${performance.indexName}.`,
  );
} catch (error) {
  console.error(error);
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
  if (redis.isOpen) redis.destroy();
  await pool.end();
}

function orderPayload(externalId, options = {}) {
  const totalMinor = options.totalMinor ?? 2_000;
  const quantity = options.quantity ?? 1;
  const currency = options.currency ?? 'USD';
  const channel = options.channel ?? 'online';
  const location = options.location ?? 'east';
  return {
    channel: {
      externalId: `channel-${channel}`,
      kind: channel === 'pos' ? 'pos' : 'storefront',
      name: channel === 'pos' ? 'Point of sale' : 'Online store',
    },
    currency,
    externalId: `${externalId}-${runId}`,
    fulfilments: [],
    items: [
      {
        externalId: `line-${externalId}`,
        name: `Product ${externalId}`,
        productExternalId: `product-${externalId}`,
        quantity,
        sku: `SKU-${externalId.toUpperCase()}`,
        totalMinor,
        unitPriceMinor: totalMinor / quantity,
      },
    ],
    location: {
      countryCode: 'US',
      externalId: `location-${location}`,
      kind: 'warehouse',
      name: location === 'west' ? 'West warehouse' : 'East warehouse',
      timezone: 'UTC',
    },
    occurredAt: options.occurredAt,
    orderNumber: `ORDER-${externalId}-${runId}`,
    payment: {
      authorizedMinor: totalMinor,
      capturedMinor: totalMinor,
      refundedMinor: options.refundedMinor ?? 0,
      status: options.refundedMinor ? 'partially_refunded' : 'captured',
    },
    returns: [],
    status: options.status ?? 'confirmed',
    subtotalMinor: totalMinor,
    totalMinor,
  };
}

async function sourceMetrics(organizationId) {
  const result = await pool.query(
    `SELECT
       coalesce(sum(CASE WHEN orders.status <> 'cancelled'
         THEN greatest(orders.total_minor - coalesce(payment.refunded_minor, 0), 0)
         ELSE 0 END), 0)::text AS "revenueMinor",
       count(*) FILTER (WHERE orders.status <> 'cancelled')::text AS "orderCount",
       coalesce(sum(items.quantity) FILTER (WHERE orders.status <> 'cancelled'), 0)::text AS "itemsSold",
       coalesce(round(sum(CASE WHEN orders.status <> 'cancelled'
         THEN greatest(orders.total_minor - coalesce(payment.refunded_minor, 0), 0)
         ELSE 0 END)::numeric /
         nullif(count(*) FILTER (WHERE orders.status <> 'cancelled'), 0)), 0)::bigint::text
         AS "averageOrderValueMinor"
     FROM orders
     LEFT JOIN payment_summaries payment
       ON payment.organization_id = orders.organization_id AND payment.order_id = orders.id
     LEFT JOIN LATERAL (
       SELECT coalesce(sum(quantity), 0)::bigint AS quantity FROM order_items
       WHERE organization_id = orders.organization_id AND order_id = orders.id
     ) items ON true
     WHERE orders.organization_id = $1 AND orders.currency = 'USD'
       AND orders.occurred_at >= '2026-09-01' AND orders.occurred_at < '2026-09-10'`,
    [organizationId],
  );
  return result.rows[0];
}

async function verifyRowSecurity(organizationA, organizationB) {
  const role = `phase5_rls_${runId}`;
  const client = await pool.connect();
  try {
    await client.query(`CREATE ROLE ${role} NOLOGIN`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await client.query(`GRANT SELECT ON orders, sales_exports TO ${role}`);
    await client.query(`SET ROLE ${role}`);
    const hidden = await client.query(
      'SELECT count(*)::int AS count FROM orders',
    );
    assert.equal(hidden.rows[0].count, 0);
    await client.query("SELECT set_config('app.organization_id', $1, false)", [
      organizationA,
    ]);
    const visible = await client.query(
      'SELECT DISTINCT organization_id FROM orders',
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
      // Cleanup must not mask an assertion failure.
    }
    client.release();
  }
}

async function verifyQueryPlan(ownerId) {
  const organizationId = await createOrganization(ownerId, 'Sales Performance');
  const channel = await pool.query(
    `INSERT INTO channels (organization_id, external_id, name, kind)
     VALUES ($1, 'performance', 'Performance feed', 'storefront') RETURNING id`,
    [organizationId],
  );
  const channelId = channel.rows[0]?.id;
  assert.ok(channelId);
  await pool.query(
    `INSERT INTO orders (
       organization_id, channel_id, external_id, order_number, status,
       currency, subtotal_minor, total_minor, occurred_at
     )
     SELECT $1, $2, 'perf-' || value, 'PERF-' || value, 'confirmed',
       'USD', 1000 + value % 5000, 1000 + value % 5000,
       now() - (value * interval '10.5 minutes')
     FROM generate_series(1, 100000) value`,
    [organizationId, channelId],
  );
  await pool.query('ANALYZE orders');
  const explained = await pool.query(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
     WITH filtered AS (
       SELECT orders.*,
         coalesce(payment.refunded_minor, 0) AS refunded_minor
       FROM orders
       LEFT JOIN payment_summaries payment
         ON payment.organization_id = orders.organization_id
         AND payment.order_id = orders.id
       WHERE orders.organization_id = $1 AND orders.currency = 'USD'
         AND orders.occurred_at >= now() - interval '30 days'
         AND orders.occurred_at < now()
     )
     SELECT
       count(*) FILTER (WHERE filtered.status <> 'cancelled'),
       coalesce(sum(CASE WHEN filtered.status <> 'cancelled'
         THEN greatest(filtered.total_minor - filtered.refunded_minor, 0)
         ELSE 0 END), 0),
       coalesce(sum(items.quantity)
         FILTER (WHERE filtered.status <> 'cancelled'), 0),
       round(sum(CASE WHEN filtered.status <> 'cancelled'
         THEN greatest(filtered.total_minor - filtered.refunded_minor, 0)
         ELSE 0 END)::numeric /
         nullif(count(*) FILTER (WHERE filtered.status <> 'cancelled'), 0))
     FROM filtered
     LEFT JOIN LATERAL (
       SELECT coalesce(sum(quantity), 0)::bigint AS quantity
       FROM order_items
       WHERE organization_id = filtered.organization_id
         AND order_id = filtered.id
     ) items ON true`,
    [organizationId],
  );
  const report = explained.rows[0]?.['QUERY PLAN']?.[0];
  assert.ok(report);
  const indexName = findIndex(report.Plan);
  assert.match(
    indexName ?? '',
    /orders_(sales_currency_)?timeline_idx/,
    'sales range query must remain index-backed',
  );
  assert.ok(
    report['Execution Time'] < 1_000,
    `query took ${report['Execution Time']} ms`,
  );
  return { executionMs: report['Execution Time'], indexName };
}

function findIndex(plan) {
  if (plan['Index Name']) return plan['Index Name'];
  for (const child of plan.Plans ?? []) {
    const name = findIndex(child);
    if (name) return name;
  }
  return undefined;
}

async function createActiveImport(organizationId, userId) {
  const result = await pool.query(
    `INSERT INTO data_imports (
       organization_id, requested_by_user_id, idempotency_key, filename,
       content_sha256, csv_payload, status, processing_started_at
     ) VALUES ($1, $2, $3, 'active.csv', $4, 'pending', 'processing', now())
     RETURNING id`,
    [organizationId, userId, `active-${runId}`, 'a'.repeat(64)],
  );
  return result.rows[0]?.id;
}

async function waitForExport(basePath, session, exportId) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const job = await expectJson(
      'export status is readable',
      await authenticatedRequest(`${basePath}/exports/${exportId}`, session),
      200,
    );
    if (job.status === 'completed' || job.status === 'failed') return job;
    await delay(100);
  }
  throw new Error(
    `Sales export ${exportId} did not complete within 12 seconds`,
  );
}

async function createUser(label) {
  const result = await pool.query(
    `INSERT INTO identity_users (issuer, subject, email, display_name)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [
      `urn:analytics-admin:sales:${runId}`,
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
    if (api.exitCode !== null || worker.exitCode !== null) {
      throw new Error(
        `Sales process exited early: API ${api.exitCode}, worker ${worker.exitCode}`,
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
  throw new Error('Sales API did not become ready within 15 seconds');
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
    throw new Error(`${name} is required for Sales integration tests`);
  return value;
}

function onceExited(child) {
  return new Promise((resolve) => child.once('exit', resolve));
}
