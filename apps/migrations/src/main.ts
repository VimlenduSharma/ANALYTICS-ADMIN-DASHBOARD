import {
  applyMigrations,
  grantRuntimeAccess,
  verifyMigrations,
} from '@analytics-admin/data-core';
import { Client } from 'pg';

async function main(): Promise<void> {
  const migrationUrl = required('MIGRATION_DATABASE_URL');
  const runtimeUrl = required('DATABASE_URL');
  const runtimeRole = required('RUNTIME_DATABASE_ROLE');
  if (migrationUrl === runtimeUrl) {
    throw new Error('Migration and runtime database identities must differ');
  }
  if (decodeURIComponent(new URL(runtimeUrl).username) !== runtimeRole) {
    throw new Error('DATABASE_URL user must match RUNTIME_DATABASE_ROLE');
  }

  const migration = new Client({
    application_name: 'analytics-migration-runner',
    connectionString: migrationUrl,
    connectionTimeoutMillis: 10_000,
  });
  const runtime = new Client({
    application_name: 'analytics-migration-verifier',
    connectionString: runtimeUrl,
    connectionTimeoutMillis: 10_000,
  });

  try {
    await migration.connect();
    await applyMigrations(migration);
    await grantRuntimeAccess(migration, runtimeRole);
    await verifyMigrations(migration);
    await runtime.connect();
    await verifyMigrations(runtime);
    console.log('Database migration gate passed.');
  } finally {
    await Promise.allSettled([migration.end(), runtime.end()]);
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Migration failed');
  process.exitCode = 1;
});
