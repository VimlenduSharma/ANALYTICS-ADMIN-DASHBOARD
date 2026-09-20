import { loadEnvironment } from './config';

describe('config', () => {
  const required = {
    CREDENTIAL_ENCRYPTION_KEY: 'b'.repeat(43),
    DATABASE_URL: 'postgresql://user:password@localhost:5432/analytics',
    REDIS_URL: 'redis://localhost:6379',
    WEBHOOK_SIGNING_KEY: 'a'.repeat(43),
  };

  it('coerces numeric values and applies safe defaults', () => {
    expect(loadEnvironment({ ...required, API_PORT: '4100' })).toMatchObject({
      API_HOST: '0.0.0.0',
      API_PORT: 4100,
      API_REQUEST_TIMEOUT_MS: 8_000,
      CACHE_TTL_SECONDS: 20,
      CIRCUIT_FAILURE_THRESHOLD: 3,
      CIRCUIT_RESET_MS: 5_000,
      DATABASE_CONNECTION_TIMEOUT_MS: 2_000,
      DATABASE_IDLE_TIMEOUT_MS: 30_000,
      DATABASE_POOL_MAX: 10,
      DATABASE_POOL_MAX_WAITING: 20,
      DATABASE_POOL_MIN: 0,
      DATABASE_STATEMENT_TIMEOUT_MS: 10_000,
      DEPENDENCY_TIMEOUT_MS: 1_500,
      IMPORT_MAX_BYTES: 2_097_152,
      IMPORT_MAX_ROWS: 10_000,
      IMPORT_POLL_MS: 2_000,
      GOVERNANCE_JOB_POLL_MS: 2_000,
      NODE_ENV: 'development',
      QUEUE_DRAIN_LIMIT: 25,
      QUEUE_MAX_PENDING_PER_ORG: 100,
      RATE_LIMIT_API_MAX: 600,
      RATE_LIMIT_AUTH_MAX: 20,
      RATE_LIMIT_WEBHOOK_MAX: 1_200,
      RATE_LIMIT_WINDOW_SECONDS: 60,
      SALES_EXPORT_MAX_ROWS: 50_000,
      SALES_EXPORT_POLL_MS: 2_000,
      SESSION_ABSOLUTE_TTL_SECONDS: 86_400,
      SESSION_IDLE_TTL_SECONDS: 28_800,
      SESSION_ROTATION_SECONDS: 900,
      WORKER_HEARTBEAT_MS: 60_000,
      WORKER_SHUTDOWN_GRACE_MS: 15_000,
    });
  });

  it('rejects an invalid database protocol without echoing credentials', () => {
    expect(() =>
      loadEnvironment({
        ...required,
        DATABASE_URL: 'https://secret@host.test',
      }),
    ).toThrow('DATABASE_URL: must use the postgres or postgresql protocol');
  });

  it('accepts a TLS Redis endpoint', () => {
    expect(
      loadEnvironment({
        ...required,
        REDIS_URL: 'rediss://default:secret@redis.example.test:6379',
      }).REDIS_URL,
    ).toBe('rediss://default:secret@redis.example.test:6379');
  });

  it('rejects a non-Redis dependency URL', () => {
    expect(() =>
      loadEnvironment({ ...required, REDIS_URL: 'https://redis.example.test' }),
    ).toThrow('REDIS_URL: must use the redis or rediss protocol');
  });

  it('rejects a weak edge proxy secret', () => {
    expect(() =>
      loadEnvironment({ ...required, EDGE_PROXY_SECRET: 'too-short' }),
    ).toThrow('EDGE_PROXY_SECRET');
  });

  it('rejects a missing or weak webhook root key', () => {
    expect(() =>
      loadEnvironment({
        DATABASE_URL: required.DATABASE_URL,
        REDIS_URL: required.REDIS_URL,
      }),
    ).toThrow('WEBHOOK_SIGNING_KEY');
    expect(() =>
      loadEnvironment({ ...required, WEBHOOK_SIGNING_KEY: 'too-short' }),
    ).toThrow('WEBHOOK_SIGNING_KEY');
  });

  it('requires an exact 32-byte credential encryption key', () => {
    expect(() =>
      loadEnvironment({ ...required, CREDENTIAL_ENCRYPTION_KEY: 'weak' }),
    ).toThrow('CREDENTIAL_ENCRYPTION_KEY');
  });

  it('requires a complete OIDC configuration in production', () => {
    expect(() =>
      loadEnvironment({
        ...required,
        NODE_ENV: 'production',
        OIDC_CLIENT_ID: 'analytics-admin',
      }),
    ).toThrow('OIDC_CLIENT_SECRET: is required when OIDC is enabled');
  });

  it('keeps rotation shorter than the idle session lifetime', () => {
    expect(() =>
      loadEnvironment({
        ...required,
        SESSION_IDLE_TTL_SECONDS: '900',
        SESSION_ROTATION_SECONDS: '900',
      }),
    ).toThrow('SESSION_ROTATION_SECONDS');
  });

  it('keeps the API deadline inside the database statement deadline', () => {
    expect(() =>
      loadEnvironment({
        ...required,
        API_REQUEST_TIMEOUT_MS: '10000',
        DATABASE_STATEMENT_TIMEOUT_MS: '10000',
      }),
    ).toThrow('API_REQUEST_TIMEOUT_MS');
  });

  it('requires protected metrics in production', () => {
    expect(() =>
      loadEnvironment({
        ...required,
        NODE_ENV: 'production',
        OIDC_CLIENT_ID: 'analytics-admin',
        OIDC_CLIENT_SECRET: 'provider-secret',
        OIDC_ISSUER_URL: 'https://identity.example.test',
        OIDC_REDIRECT_URI:
          'https://dashboard.example.test/api/v1/auth/callback',
      }),
    ).toThrow('METRICS_BEARER_TOKEN: is required in production');
  });

  it('requires HTTPS identity endpoints in production', () => {
    expect(() =>
      loadEnvironment({
        ...required,
        NODE_ENV: 'production',
        OIDC_CLIENT_ID: 'analytics-admin',
        OIDC_CLIENT_SECRET: 'not-a-real-secret',
        OIDC_ISSUER_URL: 'http://identity.example.test',
        OIDC_REDIRECT_URI:
          'https://dashboard.example.test/api/v1/auth/callback',
      }),
    ).toThrow('OIDC_ISSUER_URL: must use HTTPS in production');
  });
});
