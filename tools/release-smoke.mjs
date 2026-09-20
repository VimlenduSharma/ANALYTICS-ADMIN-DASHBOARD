import assert from 'node:assert/strict';

const baseUrl = new URL(required('APPLICATION_URL'));
if (baseUrl.protocol !== 'https:' && process.env.ALLOW_HTTP_LOCAL !== 'true') {
  throw new Error('APPLICATION_URL must use HTTPS');
}
baseUrl.pathname = baseUrl.pathname.replace(/\/?$/, '/');

const web = await request('healthz');
assert.equal(web.status, 204, 'edge health endpoint must return 204');

const readiness = await request('api/v1/health/ready');
assert.equal(readiness.status, 200, 'API readiness must return 200');
const health = await readiness.json();
assert.equal(health.status, 'ok', 'API dependencies must be ready');

const notFound = await request(`release-smoke-${Date.now()}`);
assert.equal(notFound.status, 404, 'unknown routes must retain HTTP 404');
assert.match(
  notFound.headers.get('content-type') ?? '',
  /text\/html/,
  'the application must render the 404 response',
);

const root = await request('');
assert.equal(root.status, 200, 'application root must return 200');
for (const [name, expected] of [
  ['content-security-policy', /default-src 'self'/],
  ['referrer-policy', /no-referrer/],
  ['x-content-type-options', /nosniff/],
  ['x-frame-options', /DENY/],
]) {
  assert.match(root.headers.get(name) ?? '', expected, `${name} is required`);
}
if (baseUrl.protocol === 'https:') {
  assert.match(
    root.headers.get('strict-transport-security') ?? '',
    /max-age=/,
    'HSTS is required over HTTPS',
  );
}

console.log(`Release smoke passed for ${baseUrl.origin}.`);

function request(path) {
  return fetch(new URL(path, baseUrl), {
    headers: { 'user-agent': 'analytics-release-smoke/1.0' },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
