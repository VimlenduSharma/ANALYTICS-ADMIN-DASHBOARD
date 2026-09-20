import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from 'node:crypto';
import { createServer } from 'node:http';

const host = '127.0.0.1';
const port = 4_300;
const issuer = `http://${host}:${port}`;
const clientId = 'analytics-admin-e2e';
const clientSecret = 'browser-test-only-secret';
const redirectUri = 'http://localhost:4200/api/v1/auth/callback';
const keyId = randomBytes(12).toString('base64url');
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2_048,
});
const publicJwk = {
  ...publicKey.export({ format: 'jwk' }),
  alg: 'RS256',
  kid: keyId,
  use: 'sig',
};
const authorizationRequests = new Map();
const authorizationCodes = new Map();

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', issuer);

  if (request.method === 'GET' && url.pathname === '/health') {
    return json(response, 200, { status: 'ok' });
  }
  if (
    request.method === 'GET' &&
    url.pathname === '/.well-known/openid-configuration'
  ) {
    return json(response, 200, {
      authorization_endpoint: `${issuer}/authorize`,
      claims_supported: ['sub', 'email', 'email_verified', 'name'],
      code_challenge_methods_supported: ['S256'],
      id_token_signing_alg_values_supported: ['RS256'],
      issuer,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ['code'],
      scopes_supported: ['openid', 'email', 'profile'],
      subject_types_supported: ['public'],
      token_endpoint: `${issuer}/token`,
      token_endpoint_auth_methods_supported: ['client_secret_post'],
    });
  }
  if (request.method === 'GET' && url.pathname === '/jwks') {
    return json(response, 200, { keys: [publicJwk] });
  }
  if (request.method === 'GET' && url.pathname === '/authorize') {
    return authorize(url, response);
  }
  if (request.method === 'GET' && url.pathname === '/approve') {
    return approve(url, response);
  }
  if (request.method === 'POST' && url.pathname === '/token') {
    return token(request, response);
  }

  response.writeHead(404).end('Not found');
});

server.listen(port, host, () => {
  console.log(`OIDC browser-test provider listening on ${issuer}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

function authorize(url, response) {
  const input = Object.fromEntries(url.searchParams);
  if (
    input.client_id !== clientId ||
    input.redirect_uri !== redirectUri ||
    input.response_type !== 'code' ||
    input.code_challenge_method !== 'S256' ||
    !input.code_challenge ||
    !input.nonce ||
    !input.state
  ) {
    return json(response, 400, { error: 'invalid_request' });
  }

  const requestId = randomBytes(24).toString('base64url');
  authorizationRequests.set(requestId, input);
  response.writeHead(200, {
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
    'content-type': 'text/html; charset=utf-8',
  });
  response.end(`<!doctype html>
    <html lang="en"><head><meta name="viewport" content="width=device-width"><title>Test identity provider</title>
    <style>body{margin:0;background:#111815;color:#f5f7f5;font:16px system-ui;display:grid;min-height:100vh;place-items:center}.card{background:#18221e;border:1px solid #34483f;border-radius:24px;max-width:420px;padding:40px;box-shadow:0 24px 70px #0008}small{color:#8ed9bf;text-transform:uppercase;letter-spacing:.12em}h1{font-size:32px;margin:14px 0}p{color:#b8c7c0;line-height:1.6}a{background:#5ee0b2;border-radius:999px;color:#092018;display:block;font-weight:700;margin-top:28px;padding:14px;text-align:center;text-decoration:none}</style></head>
    <body><main class="card"><small>Isolated browser test</small><h1>Confirm test identity</h1><p>This local provider verifies the complete OIDC Authorization Code and PKCE exchange. It is never included in a production process.</p><a href="/approve?request=${encodeURIComponent(requestId)}">Continue as test identity</a></main></body></html>`);
}

function approve(url, response) {
  const requestId = url.searchParams.get('request');
  const transaction = requestId
    ? authorizationRequests.get(requestId)
    : undefined;
  if (!transaction || !requestId) {
    return json(response, 400, { error: 'invalid_request' });
  }
  authorizationRequests.delete(requestId);

  const identityId = randomBytes(10).toString('hex');
  const code = randomBytes(32).toString('base64url');
  authorizationCodes.set(code, {
    challenge: transaction.code_challenge,
    nonce: transaction.nonce,
    redirectUri: transaction.redirect_uri,
    subject: `browser-${identityId}`,
    email: `browser-${identityId}@identity.test`,
  });
  const callback = new URL(transaction.redirect_uri);
  callback.searchParams.set('code', code);
  callback.searchParams.set('state', transaction.state);
  response.writeHead(302, { location: callback.toString() }).end();
}

async function token(request, response) {
  const body = new URLSearchParams(await readBody(request));
  const code = body.get('code');
  const transaction = code ? authorizationCodes.get(code) : undefined;
  if (
    !code ||
    !transaction ||
    body.get('grant_type') !== 'authorization_code' ||
    body.get('client_id') !== clientId ||
    body.get('client_secret') !== clientSecret ||
    body.get('redirect_uri') !== transaction.redirectUri ||
    pkceChallenge(body.get('code_verifier') ?? '') !== transaction.challenge
  ) {
    return json(response, 400, { error: 'invalid_grant' });
  }
  authorizationCodes.delete(code);

  const now = Math.floor(Date.now() / 1_000);
  const idToken = jwt({
    aud: clientId,
    email: transaction.email,
    email_verified: true,
    exp: now + 300,
    iat: now,
    iss: issuer,
    name: 'Identity Test Owner',
    nonce: transaction.nonce,
    sub: transaction.subject,
  });
  return json(
    response,
    200,
    {
      access_token: randomBytes(32).toString('base64url'),
      expires_in: 300,
      id_token: idToken,
      token_type: 'Bearer',
    },
    { 'cache-control': 'no-store', pragma: 'no-cache' },
  );
}

function jwt(claims) {
  const header = encode({ alg: 'RS256', kid: keyId, typ: 'JWT' });
  const payload = encode(claims);
  const data = `${header}.${payload}`;
  const signature = sign('RSA-SHA256', Buffer.from(data), privateKey);
  return `${data}.${signature.toString('base64url')}`;
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function pkceChallenge(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function json(response, status, body, headers = {}) {
  response
    .writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      ...headers,
    })
    .end(JSON.stringify(body));
}
