import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ResilienceHarness, orderPayload } from './resilience-test-harness.mjs';

const metricsToken = randomBytes(32).toString('base64url');
const harness = new ResilienceHarness({
  environment: {
    METRICS_BEARER_TOKEN: metricsToken,
    QUEUE_MAX_PENDING_PER_ORG: '2',
    RATE_LIMIT_API_MAX: '1000',
    RATE_LIMIT_AUTH_MAX: '3',
    RATE_LIMIT_WEBHOOK_MAX: '100',
    RATE_LIMIT_WINDOW_SECONDS: '60',
  },
});
let checks = 0;
let organizationId;
let session;

try {
  await harness.start();
  ({ organizationId, session } = await harness.createTenant());
  const from = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const to = new Date().toISOString().slice(0, 10);
  const salesPath = `/api/v1/organizations/${organizationId}/sales/overview?from=${from}&to=${to}`;

  const cacheMiss = await harness.authenticatedRequest(salesPath, session);
  await harness.expectStatus('first aggregate read succeeds', cacheMiss, 200);
  assert.equal(cacheMiss.headers.get('x-analytics-cache'), 'MISS');
  checks += 1;

  const cacheHit = await harness.authenticatedRequest(salesPath, session);
  await harness.expectStatus('repeated aggregate read succeeds', cacheHit, 200);
  assert.equal(cacheHit.headers.get('x-analytics-cache'), 'HIT');
  checks += 1;

  const order = orderPayload(`rest-${harness.runId}`);
  await harness.expectStatus(
    'source mutation succeeds',
    await harness.authenticatedRequest(
      `/api/v1/organizations/${organizationId}/data/orders`,
      session,
      {
        body: order,
        headers: { 'idempotency-key': `rest-${harness.runId}` },
        method: 'POST',
      },
    ),
    201,
  );
  const invalidated = await harness.authenticatedRequest(salesPath, session);
  await harness.expectStatus('aggregate cache invalidates', invalidated, 200);
  assert.equal(invalidated.headers.get('x-analytics-cache'), 'MISS');
  checks += 2;

  const csv = orderCsv(csvRow(`csv-${harness.runId}`));
  const firstImport = await enqueueImport('first', csv);
  await enqueueImport('second', csv.replaceAll('csv-', 'csv-second-'));
  const replay = await enqueueImport('first', csv);
  assert.equal(replay.id, firstImport.id);
  checks += 3;

  const backpressure = await harness.authenticatedRequest(
    `/api/v1/organizations/${organizationId}/data/imports/orders`,
    session,
    {
      bodyText: csv.replaceAll('csv-', 'csv-third-'),
      headers: {
        'content-type': 'text/csv',
        'idempotency-key': `third-${harness.runId}`,
        'x-import-filename': 'third.csv',
      },
      method: 'POST',
    },
  );
  const backpressureBody = await harness.expectJson(
    'queue overflow is rejected',
    backpressure,
    429,
  );
  assert.equal(backpressureBody.code, 'QUEUE_BACKPRESSURE');
  checks += 1;

  const endpoint = await harness.expectJson(
    'webhook source is created',
    await harness.authenticatedRequest(
      `/api/v1/organizations/${organizationId}/data/webhooks`,
      session,
      { body: { name: 'Resilience feed' }, method: 'POST' },
    ),
    201,
  );
  const webhookOrder = orderPayload(`webhook-${harness.runId}`);
  const webhookBody = JSON.stringify(webhookOrder);
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const eventId = `event-${harness.runId}`;
  const signature = createHmac(
    'sha256',
    Buffer.from(endpoint.secret, 'base64url'),
  )
    .update(`${timestamp}.${webhookBody}`)
    .digest('hex');
  const webhookResponses = await Promise.all(
    Array.from({ length: 20 }, () =>
      harness.request(
        `/api/v1/organizations/${organizationId}/webhooks/orders/${endpoint.id}`,
        {
          bodyText: webhookBody,
          headers: {
            'content-type': 'application/json',
            'x-webhook-event-id': eventId,
            'x-webhook-signature': `v1=${signature}`,
            'x-webhook-timestamp': timestamp,
          },
          method: 'POST',
        },
      ),
    ),
  );
  const webhookBodies = await Promise.all(
    webhookResponses.map(async (response) => {
      assert.equal(response.status, 201);
      return response.json();
    }),
  );
  assert.equal(new Set(webhookBodies.map((body) => body.orderId)).size, 1);
  const persisted = await harness.pool.query(
    `SELECT count(*)::int AS count FROM orders
     WHERE organization_id = $1 AND external_id = $2`,
    [organizationId, webhookOrder.externalId],
  );
  assert.equal(persisted.rows[0]?.count, 1);
  checks += 2;

  for (let index = 0; index < 3; index += 1) {
    await harness.expectStatus(
      'auth request remains within its admission budget',
      await harness.authenticatedRequest('/api/v1/auth/session', session),
      200,
    );
  }
  const limited = await harness.authenticatedRequest(
    '/api/v1/auth/session',
    session,
  );
  const limitedBody = await harness.expectJson(
    'auth burst is rate limited',
    limited,
    429,
  );
  assert.equal(limitedBody.code, 'RATE_LIMITED');
  assert.match(limited.headers.get('retry-after') ?? '', /^\d+$/);
  checks += 2;

  await harness.expectStatus(
    'metrics reject a missing monitoring credential',
    await harness.request('/api/v1/observability/metrics'),
    401,
  );
  const metrics = await harness.request('/api/v1/observability/metrics', {
    headers: { authorization: `Bearer ${metricsToken}` },
  });
  const metricsBody = await harness.expectStatus(
    'monitoring credential reads Prometheus metrics',
    metrics,
    200,
  );
  assert.match(metricsBody, /analytics_api_request_duration_seconds/);
  assert.match(metricsBody, /analytics_database_pool_connections/);
  assert.match(metricsBody, /analytics_cache_requests_total/);
  checks += 2;

  const secureHeaders = await harness.request('/api/v1/health/live');
  await harness.expectStatus(
    'liveness remains admission-independent',
    secureHeaders,
    200,
  );
  assert.equal(secureHeaders.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(secureHeaders.headers.get('x-frame-options'), 'SAMEORIGIN');
  checks += 1;

  const shutdown = await harness.stop({ assertGraceful: true });
  assert.ok(shutdown.durationMs < 5_000);
  checks += 1;

  checks += await verifyRedisOutage(metricsToken);
  console.log(
    `Resilience integration gate passed: ${checks} cache, backpressure, concurrency, rate, telemetry, shutdown, and outage checks.`,
  );
} catch (error) {
  console.error(error);
  const diagnostics = harness.diagnostics();
  if (diagnostics) console.error(diagnostics);
  await harness.stop();
  throw error;
}

async function enqueueImport(key, body) {
  return harness.expectJson(
    `import ${key} is admitted`,
    await harness.authenticatedRequest(
      `/api/v1/organizations/${organizationId}/data/imports/orders`,
      session,
      {
        bodyText: body,
        headers: {
          'content-type': 'text/csv',
          'idempotency-key': `${key}-${harness.runId}`,
          'x-import-filename': `${key}.csv`,
        },
        method: 'POST',
      },
    ),
    202,
  );
}

async function verifyRedisOutage(token) {
  const port = 36_000 + Math.floor(Math.random() * 1_000);
  const output = [];
  const child = spawn(process.execPath, ['dist/apps/api/main.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      API_HOST: '127.0.0.1',
      API_PORT: String(port),
      CIRCUIT_FAILURE_THRESHOLD: '2',
      DEPENDENCY_TIMEOUT_MS: '250',
      METRICS_BEARER_TOKEN: token,
      NODE_ENV: 'test',
      OIDC_CLIENT_ID: '',
      OIDC_CLIENT_SECRET: '',
      OIDC_ISSUER_URL: '',
      OIDC_REDIRECT_URI: '',
      REDIS_URL: 'redis://127.0.0.1:6398',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => output.push(String(chunk)));
  }
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForLive(child, baseUrl, output);
    const live = await fetch(`${baseUrl}/api/v1/health/live`);
    assert.equal(live.status, 200);
    const ready = await fetch(`${baseUrl}/api/v1/health/ready`);
    assert.equal(ready.status, 503);
    const readiness = await ready.json();
    assert.equal(
      readiness.details?.dependencies?.redis?.status ??
        readiness.dependencies?.redis?.status,
      'down',
    );

    for (let index = 0; index < 2; index += 1) {
      const unavailable = await fetch(`${baseUrl}/api/v1/auth/session`);
      assert.equal(unavailable.status, 503);
    }
    const startedAt = performance.now();
    const openCircuit = await fetch(`${baseUrl}/api/v1/auth/session`);
    assert.equal(openCircuit.status, 503);
    assert.ok(performance.now() - startedAt < 200);

    const metrics = await fetch(`${baseUrl}/api/v1/observability/metrics`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(metrics.status, 200);
    assert.match(await metrics.text(), /dependency="redis"} 1/);
    return 5;
  } finally {
    child.kill('SIGTERM');
    await Promise.race([onceExited(child), delay(5_000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

async function waitForLive(child, baseUrl, output) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Fault API exited: ${output.join('')}`);
    }
    try {
      if ((await fetch(`${baseUrl}/api/v1/health/live`)).ok) return;
    } catch {
      // The process is still binding or running migrations.
    }
    await delay(150);
  }
  throw new Error(`Fault API did not start: ${output.join('')}`);
}

function csvRow(externalId) {
  return [
    externalId,
    `ORDER-${externalId}`,
    'confirmed',
    'USD',
    new Date().toISOString(),
    'resilience-store',
    'Resilience Store',
    'storefront',
    `line-${externalId}`,
    'resilience-product',
    'RES-001',
    'Load-safe product',
    '1',
    '5000',
    '5000',
    '5000',
    '5000',
  ].join(',');
}

function orderCsv(row) {
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
    row,
  ].join('\n');
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
