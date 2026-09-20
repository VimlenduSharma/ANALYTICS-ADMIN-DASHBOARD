import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ResilienceHarness } from './resilience-test-harness.mjs';

const metricsToken = randomBytes(32).toString('base64url');
const harness = new ResilienceHarness({
  environment: {
    METRICS_BEARER_TOKEN: metricsToken,
    RATE_LIMIT_API_MAX: '1000',
    RATE_LIMIT_AUTH_MAX: '1000',
  },
});
let checks = 0;

try {
  await harness.start();
  const tenantA = await harness.createTenant('Security Owner A');
  const tenantB = await harness.createTenant('Security Owner B');

  const anonymous = await harness.expectJson(
    'anonymous tenant access fails closed',
    await harness.request(
      `/api/v1/organizations/${tenantA.organizationId}/team`,
    ),
    401,
  );
  assert.equal(anonymous.code, 'AUTH_REQUIRED');
  assert.equal(typeof anonymous.requestId, 'string');
  checks += 1;

  const crossTenant = await harness.expectJson(
    'cross-tenant request fails closed',
    await harness.authenticatedRequest(
      `/api/v1/organizations/${tenantB.organizationId}/team`,
      tenantA.session,
    ),
    403,
  );
  assert.equal(crossTenant.code, 'ORGANIZATION_ACCESS_DENIED');
  checks += 1;

  const noCsrf = await harness.expectJson(
    'state change without CSRF fails closed',
    await harness.request(
      `/api/v1/organizations/${tenantA.organizationId}/data/webhooks`,
      {
        body: { name: 'Rejected source' },
        method: 'POST',
        token: tenantA.session.token,
      },
    ),
    403,
  );
  assert.equal(noCsrf.code, 'CSRF_INVALID');
  checks += 1;

  const badOrigin = await harness.expectJson(
    'untrusted origin fails closed',
    await harness.authenticatedRequest(
      `/api/v1/organizations/${tenantA.organizationId}/data/webhooks`,
      tenantA.session,
      {
        body: { name: 'Rejected source' },
        method: 'POST',
        origin: 'https://attacker.invalid',
      },
    ),
    403,
  );
  assert.equal(badOrigin.code, 'CSRF_ORIGIN_INVALID');
  checks += 1;

  const injection = await harness.expectJson(
    'query injection is rejected by boundary validation',
    await harness.authenticatedRequest(
      `/api/v1/organizations/${tenantA.organizationId}/sales/overview?status=${encodeURIComponent("confirmed' OR 1=1 --")}`,
      tenantA.session,
    ),
    400,
  );
  assert.equal(injection.code, 'VALIDATION_FAILED');
  checks += 1;

  const created = await harness.expectJson(
    'manager creates a write-only credential',
    await harness.authenticatedRequest(
      `/api/v1/organizations/${tenantA.organizationId}/data/webhooks`,
      tenantA.session,
      { body: { name: 'Security verification' }, method: 'POST' },
    ),
    201,
  );
  assert.match(created.secret, /^[A-Za-z0-9_-]{43}$/);
  const sources = await harness.expectJson(
    'subsequent source reads omit the credential',
    await harness.authenticatedRequest(
      `/api/v1/organizations/${tenantA.organizationId}/data/webhooks`,
      tenantA.session,
    ),
    200,
  );
  assert.ok(sources.every((source) => !('secret' in source)));
  checks += 2;

  const wrongMetricsToken = await harness.expectJson(
    'metrics reject an incorrect credential',
    await harness.request('/api/v1/observability/metrics', {
      headers: { authorization: `Bearer ${'x'.repeat(32)}` },
    }),
    401,
  );
  assert.equal(wrongMetricsToken.code, 'METRICS_AUTH_REQUIRED');
  checks += 1;

  const cors = await harness.request('/api/v1/health/live', {
    headers: { origin: 'https://attacker.invalid' },
  });
  await harness.expectStatus(
    'untrusted CORS origin receives no grant',
    cors,
    200,
  );
  assert.equal(cors.headers.get('access-control-allow-origin'), null);
  checks += 1;

  const notFound = await harness.expectJson(
    'unexpected paths return a redacted error envelope',
    await harness.request('/api/v1/does-not-exist'),
    404,
  );
  const serialized = JSON.stringify(notFound);
  assert.ok(!serialized.includes('stack'));
  assert.ok(!serialized.includes(process.env.DATABASE_URL ?? 'never-match'));
  checks += 1;

  const headers = await harness.request('/api/v1/health/live');
  await harness.expectStatus('security headers are applied', headers, 200);
  assert.equal(headers.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(headers.headers.get('referrer-policy'), 'no-referrer');
  checks += 1;

  console.log(
    `Security integration gate passed: ${checks} tenant, CSRF, origin, injection, credential, telemetry, CORS, redaction, and header checks.`,
  );
} catch (error) {
  const diagnostics = harness.diagnostics();
  if (diagnostics) console.error(diagnostics);
  throw error;
} finally {
  await harness.stop();
}
