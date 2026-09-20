const edgeProxyHeader = 'x-edge-proxy-secret';
const edgeClientIpHeader = 'x-edge-client-ip';
const hopByHopHeaders = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

export async function onRequest(context) {
  const upstreamOrigin = validOrigin(context.env.API_ORIGIN);
  const edgeSecret = context.env.EDGE_PROXY_SECRET?.trim();
  if (!upstreamOrigin || !edgeSecret || edgeSecret.length < 32) {
    return unavailable();
  }

  const incoming = new URL(context.request.url);
  const upstream = new URL(
    `${incoming.pathname}${incoming.search}`,
    upstreamOrigin,
  );
  const headers = new Headers(context.request.headers);
  for (const name of hopByHopHeaders) headers.delete(name);
  headers.delete(edgeProxyHeader);
  headers.delete(edgeClientIpHeader);
  headers.set(edgeProxyHeader, edgeSecret);
  headers.set(edgeClientIpHeader, headers.get('cf-connecting-ip') ?? 'unknown');
  headers.set('x-forwarded-host', incoming.host);
  headers.set('x-forwarded-proto', 'https');

  const request = new Request(upstream, {
    body: ['GET', 'HEAD'].includes(context.request.method)
      ? undefined
      : context.request.body,
    headers,
    method: context.request.method,
    redirect: 'manual',
  });

  try {
    return await fetch(request);
  } catch {
    return unavailable();
  }
}

function validOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      ? `${url.origin}/`
      : undefined;
  } catch {
    return undefined;
  }
}

function unavailable() {
  return Response.json(
    {
      code: 'EDGE_UPSTREAM_UNAVAILABLE',
      message: 'The application service is temporarily unavailable',
    },
    {
      headers: { 'cache-control': 'no-store' },
      status: 503,
    },
  );
}
