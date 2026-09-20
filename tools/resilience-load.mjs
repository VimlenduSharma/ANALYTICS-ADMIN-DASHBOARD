import assert from 'node:assert/strict';
import { ResilienceHarness, orderPayload } from './resilience-test-harness.mjs';

const profile = {
  concurrency: Number(process.env.LOAD_CONCURRENCY ?? 30),
  durationSeconds: Number(process.env.LOAD_DURATION_SECONDS ?? 30),
  requestsPerSecond: Number(process.env.LOAD_REQUESTS_PER_SECOND ?? 60),
  seedOrders: Number(process.env.LOAD_SEED_ORDERS ?? 250),
};
const budgets = {
  health: 100,
  operations: 400,
  orders: 300,
  sales: 300,
};
const harness = new ResilienceHarness({
  environment: {
    CACHE_TTL_SECONDS: '30',
    DATABASE_POOL_MAX: '10',
    DATABASE_POOL_MAX_WAITING: '60',
    RATE_LIMIT_API_MAX: '10000',
    RATE_LIMIT_AUTH_MAX: '10000',
    RATE_LIMIT_WEBHOOK_MAX: '10000',
  },
});

try {
  await harness.start();
  const { organizationId, session } = await harness.createTenant('Load Owner');
  await seed(organizationId, session);

  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 30 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const paths = {
    health: '/api/v1/health/live',
    operations: `/api/v1/organizations/${organizationId}/operations/overview?from=${from}&to=${to}`,
    orders: `/api/v1/organizations/${organizationId}/sales/orders?from=${from}&to=${to}&pageSize=25`,
    sales: `/api/v1/organizations/${organizationId}/sales/overview?from=${from}&to=${to}`,
  };

  for (const name of ['sales', 'operations', 'orders']) {
    const response = await harness.authenticatedRequest(paths[name], session);
    assert.equal(
      response.status,
      200,
      `Warm-up ${name} returned ${response.status}`,
    );
    await response.arrayBuffer();
  }

  const results = Object.fromEntries(
    Object.keys(paths).map((name) => [name, { durations: [], errors: 0 }]),
  );
  const inFlight = new Set();
  const total = profile.durationSeconds * profile.requestsPerSecond;
  const intervalMs = 1_000 / profile.requestsPerSecond;
  const startedAt = performance.now();

  for (let index = 0; index < total; index += 1) {
    const scheduledAt = startedAt + index * intervalMs;
    const remaining = scheduledAt - performance.now();
    if (remaining > 0)
      await new Promise((resolve) => setTimeout(resolve, remaining));
    if (inFlight.size >= profile.concurrency) await Promise.race(inFlight);
    const name = routeFor(index);
    const request = measure(name, paths[name], session, results).finally(() =>
      inFlight.delete(request),
    );
    inFlight.add(request);
  }
  await Promise.all(inFlight);

  const completed = Object.values(results).reduce(
    (sum, result) => sum + result.durations.length,
    0,
  );
  const errors = Object.values(results).reduce(
    (sum, result) => sum + result.errors,
    0,
  );
  const elapsedSeconds = (performance.now() - startedAt) / 1_000;
  const report = {
    achievedRequestsPerSecond: Number((completed / elapsedSeconds).toFixed(2)),
    elapsedSeconds: Number(elapsedSeconds.toFixed(2)),
    errorRatePercent: Number(((errors / completed) * 100).toFixed(3)),
    profile,
    routes: Object.fromEntries(
      Object.entries(results).map(([name, result]) => [
        name,
        {
          budgetP95Ms: budgets[name],
          count: result.durations.length,
          errors: result.errors,
          p50Ms: percentile(result.durations, 0.5),
          p95Ms: percentile(result.durations, 0.95),
          p99Ms: percentile(result.durations, 0.99),
        },
      ]),
    ),
  };

  assert.ok(
    report.errorRatePercent < 1,
    `Error rate was ${report.errorRatePercent}%`,
  );
  for (const [name, route] of Object.entries(report.routes)) {
    assert.ok(
      route.p95Ms <= route.budgetP95Ms,
      `${name} p95 ${route.p95Ms}ms exceeded ${route.budgetP95Ms}ms`,
    );
  }
  console.log('Resilience load gate passed.');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const diagnostics = harness.diagnostics();
  if (diagnostics) console.error(diagnostics);
  throw error;
} finally {
  await harness.stop();
}

async function seed(organizationId, session) {
  const concurrency = 10;
  for (let offset = 0; offset < profile.seedOrders; offset += concurrency) {
    await Promise.all(
      Array.from(
        { length: Math.min(concurrency, profile.seedOrders - offset) },
        async (_value, index) => {
          const position = offset + index;
          const externalId = `load-${harness.runId}-${position}`;
          const occurredAt = new Date(
            Date.now() - (position % 25) * 86_400_000,
          ).toISOString();
          const response = await harness.authenticatedRequest(
            `/api/v1/organizations/${organizationId}/data/orders`,
            session,
            {
              body: orderPayload(externalId, occurredAt),
              headers: { 'idempotency-key': `seed-${externalId}` },
              method: 'POST',
            },
          );
          assert.equal(
            response.status,
            201,
            `Seed request returned ${response.status}`,
          );
          await response.arrayBuffer();
        },
      ),
    );
  }
}

async function measure(name, path, session, results) {
  const startedAt = performance.now();
  try {
    const response =
      name === 'health'
        ? await harness.request(path)
        : await harness.authenticatedRequest(path, session);
    await response.arrayBuffer();
    if (!response.ok) results[name].errors += 1;
  } catch {
    results[name].errors += 1;
  } finally {
    results[name].durations.push(performance.now() - startedAt);
  }
}

function routeFor(index) {
  const slot = index % 20;
  if (slot < 2) return 'health';
  if (slot < 11) return 'sales';
  if (slot < 16) return 'operations';
  return 'orders';
}

function percentile(values, quantile) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil(sorted.length * quantile) - 1,
  );
  return Number((sorted[index] ?? 0).toFixed(2));
}
