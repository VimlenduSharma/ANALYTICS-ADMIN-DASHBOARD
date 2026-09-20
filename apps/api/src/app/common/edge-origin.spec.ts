import {
  acceptsEdgeRequest,
  edgeClientIpHeader,
  edgeProxyHeader,
  trustedClientIdentity,
} from './edge-origin';

describe('edge origin boundary', () => {
  const secret = 'e'.repeat(43);

  it('fails closed when the configured edge proof is absent or incorrect', () => {
    expect(
      acceptsEdgeRequest({ headers: {}, url: '/api/v1/auth/session' }, secret),
    ).toBe(false);
    expect(
      acceptsEdgeRequest(
        {
          headers: { [edgeProxyHeader]: 'incorrect' },
          url: '/api/v1/auth/session',
        },
        secret,
      ),
    ).toBe(false);
  });

  it('accepts edge-proven requests and provider health probes', () => {
    expect(
      acceptsEdgeRequest(
        {
          headers: { [edgeProxyHeader]: secret },
          url: '/api/v1/auth/session',
        },
        secret,
      ),
    ).toBe(true);
    expect(
      acceptsEdgeRequest(
        { headers: {}, url: '/api/v1/health/ready?probe=provider' },
        secret,
      ),
    ).toBe(true);
  });

  it('uses an edge-supplied client address only when the edge is enforced', () => {
    const request = {
      headers: { [edgeClientIpHeader]: '203.0.113.8' },
      ip: '127.0.0.1',
    };
    expect(trustedClientIdentity(request, true)).toBe('203.0.113.8');
    expect(trustedClientIdentity(request, false)).toBe('127.0.0.1');
  });
});
