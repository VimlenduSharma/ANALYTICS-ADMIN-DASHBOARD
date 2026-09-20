import assert from 'node:assert/strict';
import test from 'node:test';
import { onRequest } from '../functions/api/[[path]].js';

const edgeSecret = 'e'.repeat(43);

test('the edge proxy replaces proof headers and preserves the API request', async () => {
  const originalFetch = globalThis.fetch;
  let forwarded;
  globalThis.fetch = async (request) => {
    forwarded = request;
    return Response.json({ status: 'ok' });
  };

  try {
    const response = await onRequest({
      env: {
        API_ORIGIN: 'https://api.example.code.run',
        EDGE_PROXY_SECRET: edgeSecret,
      },
      request: new Request(
        'https://analytics-admin-dashboard.pages.dev/api/v1/auth/session?fresh=true',
        {
          headers: {
            'cf-connecting-ip': '203.0.113.8',
            'x-edge-client-ip': 'spoofed',
            'x-edge-proxy-secret': 'spoofed',
          },
        },
      ),
    });

    assert.equal(response.status, 200);
    assert.equal(
      forwarded.url,
      'https://api.example.code.run/api/v1/auth/session?fresh=true',
    );
    assert.equal(forwarded.headers.get('x-edge-proxy-secret'), edgeSecret);
    assert.equal(forwarded.headers.get('x-edge-client-ip'), '203.0.113.8');
    assert.equal(
      forwarded.headers.get('x-forwarded-host'),
      'analytics-admin-dashboard.pages.dev',
    );
    assert.equal(forwarded.headers.get('x-forwarded-proto'), 'https');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the edge proxy fails closed when provider configuration is absent', async () => {
  const response = await onRequest({
    env: {},
    request: new Request(
      'https://analytics-admin-dashboard.pages.dev/api/v1/auth/session',
    ),
  });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('the edge proxy refuses insecure or credential-bearing origins', async () => {
  for (const API_ORIGIN of [
    'http://api.example.test',
    'https://user:password@api.example.test',
  ]) {
    const response = await onRequest({
      env: { API_ORIGIN, EDGE_PROXY_SECRET: edgeSecret },
      request: new Request(
        'https://analytics-admin-dashboard.pages.dev/api/v1/health/ready',
      ),
    });
    assert.equal(response.status, 503);
  }
});
