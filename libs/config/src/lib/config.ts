import { z } from 'zod';

const optionalUrl = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.url().optional(),
);
const optionalText = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().trim().min(1).optional(),
);
const optionalSecret = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(32).optional(),
);

const environmentSchema = z
  .object({
    APP_VERSION: z.string().trim().min(1).default('0.1.0'),
    API_HOST: z.string().trim().min(1).default('0.0.0.0'),
    API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    API_REQUEST_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(500)
      .max(60_000)
      .default(8_000),
    CACHE_TTL_SECONDS: z.coerce.number().int().min(1).max(300).default(20),
    CIRCUIT_FAILURE_THRESHOLD: z.coerce
      .number()
      .int()
      .min(1)
      .max(20)
      .default(3),
    CIRCUIT_RESET_MS: z.coerce
      .number()
      .int()
      .min(500)
      .max(300_000)
      .default(5_000),
    CREDENTIAL_ENCRYPTION_KEY: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/, 'must be a 32-byte base64url secret'),
    DATABASE_URL: z
      .url()
      .refine(
        (value) =>
          ['postgres:', 'postgresql:'].includes(new URL(value).protocol),
        {
          message: 'must use the postgres or postgresql protocol',
        },
      ),
    DATABASE_POOL_MAX: z.coerce.number().int().min(2).max(50).default(10),
    DATABASE_POOL_MAX_WAITING: z.coerce
      .number()
      .int()
      .min(1)
      .max(500)
      .default(20),
    DATABASE_POOL_MIN: z.coerce.number().int().min(0).max(20).default(0),
    DATABASE_CONNECTION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(250)
      .max(30_000)
      .default(2_000),
    DATABASE_IDLE_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(300_000)
      .default(30_000),
    DATABASE_STATEMENT_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(500)
      .max(120_000)
      .default(10_000),
    DEPENDENCY_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(250)
      .max(10_000)
      .default(1_500),
    IMPORT_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1_024)
      .max(10_485_760)
      .default(2_097_152),
    IMPORT_MAX_ROWS: z.coerce
      .number()
      .int()
      .min(1)
      .max(100_000)
      .default(10_000),
    IMPORT_POLL_MS: z.coerce.number().int().min(500).max(60_000).default(2_000),
    GOVERNANCE_JOB_POLL_MS: z.coerce
      .number()
      .int()
      .min(500)
      .max(60_000)
      .default(2_000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'log', 'debug', 'verbose'])
      .default('log'),
    METRICS_BEARER_TOKEN: optionalSecret,
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    OIDC_CLIENT_ID: optionalText,
    OIDC_CLIENT_SECRET: optionalText,
    OIDC_ISSUER_URL: optionalUrl,
    OIDC_REDIRECT_URI: optionalUrl,
    REDIS_URL: z.url().refine((value) => new URL(value).protocol === 'redis:', {
      message: 'must use the redis protocol',
    }),
    QUEUE_DRAIN_LIMIT: z.coerce.number().int().min(1).max(1_000).default(25),
    QUEUE_MAX_PENDING_PER_ORG: z.coerce
      .number()
      .int()
      .min(1)
      .max(10_000)
      .default(100),
    RATE_LIMIT_API_MAX: z.coerce
      .number()
      .int()
      .min(10)
      .max(1_000_000)
      .default(600),
    RATE_LIMIT_AUTH_MAX: z.coerce.number().int().min(3).max(10_000).default(20),
    RATE_LIMIT_WEBHOOK_MAX: z.coerce
      .number()
      .int()
      .min(10)
      .max(1_000_000)
      .default(1_200),
    RATE_LIMIT_WINDOW_SECONDS: z.coerce
      .number()
      .int()
      .min(1)
      .max(3_600)
      .default(60),
    SALES_EXPORT_MAX_ROWS: z.coerce
      .number()
      .int()
      .min(100)
      .max(250_000)
      .default(50_000),
    SALES_EXPORT_POLL_MS: z.coerce
      .number()
      .int()
      .min(500)
      .max(60_000)
      .default(2_000),
    SESSION_ABSOLUTE_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(3_600)
      .max(604_800)
      .default(86_400),
    SESSION_IDLE_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(900)
      .max(86_400)
      .default(28_800),
    SESSION_ROTATION_SECONDS: z.coerce
      .number()
      .int()
      .min(300)
      .max(3_600)
      .default(900),
    SERVICE_NAME: z.string().trim().min(1).default('analytics-admin'),
    WEB_ORIGIN: z.url().default('http://localhost:4200'),
    WEBHOOK_CLOCK_TOLERANCE_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .max(900)
      .default(300),
    WEBHOOK_SIGNING_KEY: z
      .string()
      .regex(
        /^[A-Za-z0-9_-]{43,128}$/,
        'must be a 32-byte or stronger base64url secret',
      ),
    WORKER_HEARTBEAT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(300_000)
      .default(60_000),
    WORKER_SHUTDOWN_GRACE_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(120_000)
      .default(15_000),
  })
  .superRefine((environment, context) => {
    const oidcValues = [
      environment.OIDC_CLIENT_ID,
      environment.OIDC_CLIENT_SECRET,
      environment.OIDC_ISSUER_URL,
      environment.OIDC_REDIRECT_URI,
    ];
    const requiresOidc =
      environment.NODE_ENV === 'production' || oidcValues.some(Boolean);

    if (requiresOidc) {
      const names = [
        'OIDC_CLIENT_ID',
        'OIDC_CLIENT_SECRET',
        'OIDC_ISSUER_URL',
        'OIDC_REDIRECT_URI',
      ] as const;

      for (const [index, value] of oidcValues.entries()) {
        if (value) continue;
        const name = names[index];
        if (!name) continue;
        context.addIssue({
          code: 'custom',
          message: 'is required when OIDC is enabled',
          path: [name],
        });
      }

      if (
        environment.NODE_ENV === 'production' &&
        environment.OIDC_ISSUER_URL &&
        new URL(environment.OIDC_ISSUER_URL).protocol !== 'https:'
      ) {
        context.addIssue({
          code: 'custom',
          message: 'must use HTTPS in production',
          path: ['OIDC_ISSUER_URL'],
        });
      }

      if (
        environment.NODE_ENV === 'production' &&
        environment.OIDC_REDIRECT_URI &&
        new URL(environment.OIDC_REDIRECT_URI).protocol !== 'https:'
      ) {
        context.addIssue({
          code: 'custom',
          message: 'must use HTTPS in production',
          path: ['OIDC_REDIRECT_URI'],
        });
      }
    }

    if (
      environment.SESSION_ROTATION_SECONDS >=
      environment.SESSION_IDLE_TTL_SECONDS
    ) {
      context.addIssue({
        code: 'custom',
        message: 'must be shorter than the idle session lifetime',
        path: ['SESSION_ROTATION_SECONDS'],
      });
    }

    if (environment.DATABASE_POOL_MIN > environment.DATABASE_POOL_MAX) {
      context.addIssue({
        code: 'custom',
        message: 'must not exceed the maximum pool size',
        path: ['DATABASE_POOL_MIN'],
      });
    }

    if (
      environment.API_REQUEST_TIMEOUT_MS >=
      environment.DATABASE_STATEMENT_TIMEOUT_MS
    ) {
      context.addIssue({
        code: 'custom',
        message: 'must be shorter than the database statement timeout',
        path: ['API_REQUEST_TIMEOUT_MS'],
      });
    }

    if (
      environment.NODE_ENV === 'production' &&
      !environment.METRICS_BEARER_TOKEN
    ) {
      context.addIssue({
        code: 'custom',
        message: 'is required in production',
        path: ['METRICS_BEARER_TOKEN'],
      });
    }
  });

export type Environment = z.infer<typeof environmentSchema>;

export function loadEnvironment(input: Record<string, unknown>): Environment {
  const result = environmentSchema.safeParse(input);

  if (result.success) {
    return result.data;
  }

  const summary = result.error.issues
    .map(
      ({ message, path }) => `${path.join('.') || 'environment'}: ${message}`,
    )
    .join('; ');

  throw new Error(`Invalid environment configuration: ${summary}`);
}
