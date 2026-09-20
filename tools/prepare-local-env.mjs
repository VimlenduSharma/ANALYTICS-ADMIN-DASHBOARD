import { randomBytes } from 'node:crypto';
import {
  appendFile,
  constants,
  access,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { resolve } from 'node:path';

const environmentPath = resolve('.env');

try {
  await access(environmentPath, constants.F_OK);
  const current = await readFile(environmentPath, 'utf8');
  const additions = [];
  if (!/^WEBHOOK_SIGNING_KEY=/m.test(current))
    additions.push(
      `WEBHOOK_SIGNING_KEY=${randomBytes(32).toString('base64url')}`,
    );
  if (!/^CREDENTIAL_ENCRYPTION_KEY=/m.test(current))
    additions.push(
      `CREDENTIAL_ENCRYPTION_KEY=${randomBytes(32).toString('base64url')}`,
    );
  if (additions.length) {
    await appendFile(
      environmentPath,
      `\n# Added by a secret-safe environment upgrade.\n${additions.join('\n')}\n`,
      { mode: 0o600 },
    );
    console.log('Added missing private keys to the local environment.');
  } else console.log('Local environment already exists; leaving it unchanged.');
  process.exit(0);
} catch {
  // A missing file is the only state in which this script writes credentials.
}

const password = randomBytes(24).toString('base64url');
const encodedPassword = encodeURIComponent(password);
const webhookSigningKey = randomBytes(32).toString('base64url');
const credentialEncryptionKey = randomBytes(32).toString('base64url');
const environment = `# Generated locally. Never commit this file.
NODE_ENV=development
API_HOST=0.0.0.0
API_PORT=3000
API_REQUEST_TIMEOUT_MS=8000
APP_VERSION=0.1.0
LOG_LEVEL=log
WEB_ORIGIN=http://localhost:4200

POSTGRES_DB=analytics_admin
POSTGRES_USER=analytics_admin
POSTGRES_PASSWORD=${password}
POSTGRES_HOST_PORT=55432
DATABASE_URL=postgresql://analytics_admin:${encodedPassword}@127.0.0.1:55432/analytics_admin
REDIS_URL=redis://127.0.0.1:6379
DEPENDENCY_TIMEOUT_MS=1500
CIRCUIT_FAILURE_THRESHOLD=3
CIRCUIT_RESET_MS=5000
CACHE_TTL_SECONDS=20
RATE_LIMIT_WINDOW_SECONDS=60
RATE_LIMIT_AUTH_MAX=20
RATE_LIMIT_API_MAX=600
RATE_LIMIT_WEBHOOK_MAX=1200
DATABASE_POOL_MAX=10
DATABASE_POOL_MIN=0
DATABASE_POOL_MAX_WAITING=20
DATABASE_CONNECTION_TIMEOUT_MS=2000
DATABASE_IDLE_TIMEOUT_MS=30000
DATABASE_STATEMENT_TIMEOUT_MS=10000
SESSION_ABSOLUTE_TTL_SECONDS=86400
SESSION_IDLE_TTL_SECONDS=28800
SESSION_ROTATION_SECONDS=900
WORKER_HEARTBEAT_MS=60000
WORKER_SHUTDOWN_GRACE_MS=15000
QUEUE_DRAIN_LIMIT=25
QUEUE_MAX_PENDING_PER_ORG=100
IMPORT_MAX_BYTES=2097152
IMPORT_MAX_ROWS=10000
IMPORT_POLL_MS=2000
WEBHOOK_CLOCK_TOLERANCE_SECONDS=300
WEBHOOK_SIGNING_KEY=${webhookSigningKey}
CREDENTIAL_ENCRYPTION_KEY=${credentialEncryptionKey}
GOVERNANCE_JOB_POLL_MS=2000
`;

await writeFile(environmentPath, environment, { flag: 'wx', mode: 0o600 });
console.log('Created a private local environment with a generated password.');
