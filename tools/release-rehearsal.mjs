import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';

const suffix = randomBytes(6).toString('hex');
const databaseName = 'analytics_release_' + suffix;
const runtimeRole = 'analytics_runtime_' + suffix;
const runtimePassword = secret();
const projectName = 'analytics-release-' + suffix;
const temporaryDirectory = await mkdtemp(
  join(tmpdir(), 'analytics-release-rehearsal-'),
);
const runtimeEnvironment = join(temporaryDirectory, 'runtime.env');
const migrationEnvironment = join(temporaryDirectory, 'migration.env');
const adminUrl = required('DATABASE_URL');
const publicPort = process.env.RELEASE_REHEARSAL_PORT ?? '18080';
const images = ['api', 'migrations', 'web', 'worker'];
let databaseCreated = false;
let roleCreated = false;

const admin = new Client({
  application_name: 'analytics-release-rehearsal',
  connectionString: adminUrl,
});

try {
  await admin.connect();
  await admin.query(
    'CREATE ROLE ' +
      identifier(runtimeRole) +
      ' LOGIN PASSWORD ' +
      literal(runtimePassword),
  );
  roleCreated = true;
  await admin.query('CREATE DATABASE ' + identifier(databaseName));
  databaseCreated = true;
  await admin.query(
    'GRANT CONNECT ON DATABASE ' +
      identifier(databaseName) +
      ' TO ' +
      identifier(runtimeRole),
  );

  const migrationUrl = databaseUrl(adminUrl, databaseName);
  const runtimeUrl = databaseUrl(
    adminUrl,
    databaseName,
    runtimeRole,
    runtimePassword,
  );
  await writeFile(
    runtimeEnvironment,
    environmentText({
      API_HOST: '0.0.0.0',
      API_PORT: '3000',
      APP_VERSION: 'release-rehearsal',
      CREDENTIAL_ENCRYPTION_KEY: secret(),
      DATABASE_URL: containerUrl(runtimeUrl),
      METRICS_BEARER_TOKEN: secret(),
      NODE_ENV: 'production',
      OIDC_CLIENT_ID: 'release-rehearsal',
      OIDC_CLIENT_SECRET: secret(),
      OIDC_ISSUER_URL: 'https://identity.invalid',
      OIDC_REDIRECT_URI: 'https://analytics.invalid/api/v1/auth/callback',
      REDIS_URL: 'redis://host.docker.internal:6379',
      WEBHOOK_SIGNING_KEY: secret(),
      WEB_ORIGIN: 'https://analytics.invalid',
    }),
    { mode: 0o600 },
  );
  await writeFile(
    migrationEnvironment,
    environmentText({
      MIGRATION_DATABASE_URL: containerUrl(migrationUrl),
      RUNTIME_DATABASE_ROLE: runtimeRole,
    }),
    { mode: 0o600 },
  );

  if (process.env.RELEASE_REHEARSAL_SKIP_BUILD !== 'true') {
    run('docker', [
      'build',
      '-f',
      'deploy/Containerfile.web',
      '-t',
      'analytics-admin/web:release-check',
      '.',
    ]);
    for (const app of ['api', 'worker', 'migrations']) {
      run('docker', [
        'build',
        '-f',
        'deploy/Containerfile.runtime',
        '--build-arg',
        'APP=' + app,
        '-t',
        'analytics-admin/' + app + ':release-check',
        '.',
      ]);
    }
  }

  compose(
    ['--profile', 'migration', 'run', '--rm', 'migrations'],
    'release-check',
  );
  compose(['up', '-d', '--wait', 'api', 'worker', 'web'], 'release-check');
  smoke();

  for (const image of images) {
    run('docker', [
      'tag',
      'analytics-admin/' + image + ':release-check',
      'analytics-admin/' + image + ':rollback-check',
    ]);
  }
  compose(['up', '-d', '--wait', 'api', 'worker', 'web'], 'rollback-check');
  smoke();

  console.log(
    'Release and rollback rehearsal passed with an isolated non-owner runtime role.',
  );
} finally {
  try {
    compose(['down', '--remove-orphans'], 'release-check');
  } catch {
    // Continue exact database and temporary-file cleanup after partial startup.
  }
  if (databaseCreated) {
    await admin.query(
      'DROP DATABASE IF EXISTS ' + identifier(databaseName) + ' WITH (FORCE)',
    );
  }
  if (roleCreated) {
    await admin.query('DROP ROLE IF EXISTS ' + identifier(runtimeRole));
  }
  await admin.end();
  await rm(temporaryDirectory, { force: true, recursive: true });
}

function compose(arguments_, imageTag) {
  run(
    'docker',
    [
      'compose',
      '-p',
      projectName,
      '-f',
      'deploy/compose.release.yaml',
      ...arguments_,
    ],
    {
      EDGE_BIND_ADDRESS: '127.0.0.1',
      EDGE_PORT: publicPort,
      IMAGE_REGISTRY: 'analytics-admin',
      IMAGE_TAG: imageTag,
      MIGRATION_ENV_FILE: migrationEnvironment,
      RUNTIME_ENV_FILE: runtimeEnvironment,
    },
  );
}

function smoke() {
  run(process.execPath, ['tools/release-smoke.mjs'], {
    ALLOW_HTTP_LOCAL: 'true',
    APPLICATION_URL: 'http://127.0.0.1:' + publicPort,
  });
}

function run(command, arguments_, extraEnvironment = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: process.cwd(),
    env: { ...process.env, ...extraEnvironment },
    stdio: 'inherit',
  });
  if (result.status === 0) return;
  throw new Error(
    command +
      ' ' +
      arguments_.join(' ') +
      ' failed with status ' +
      (result.status ?? 'unknown'),
  );
}

function containerUrl(connectionString) {
  const url = new URL(connectionString);
  url.hostname = 'host.docker.internal';
  return url.toString();
}

function databaseUrl(connectionString, database, username, password) {
  const url = new URL(connectionString);
  url.pathname = '/' + database;
  if (username) url.username = username;
  if (password) url.password = password;
  return url.toString();
}

function environmentText(values) {
  return (
    Object.entries(values)
      .map(([name, value]) => name + '=' + value)
      .join('\n') + '\n'
  );
}

function identifier(value) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) {
    throw new Error('Generated PostgreSQL identifier is invalid');
  }
  return '"' + value + '"';
}

function literal(value) {
  return "'" + value.replaceAll("'", "''") + "'";
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(name + ' is required');
  return value;
}

function secret() {
  return randomBytes(32).toString('base64url');
}
