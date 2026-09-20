import type { ClientBase } from 'pg';
import { migrations } from './migrations';

const migrationLock = 2_026_090_300_1;

export async function applyMigrations(client: ClientBase): Promise<void> {
  await client.query('SELECT pg_advisory_lock($1)', [migrationLock]);
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_migrations (
        id text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    for (const migration of migrations) {
      const applied = await client.query<{ exists: boolean }>(
        'SELECT EXISTS (SELECT 1 FROM app_migrations WHERE id = $1) AS exists',
        [migration.id],
      );
      if (applied.rows[0]?.exists) continue;

      await client.query('BEGIN');
      try {
        await client.query(migration.up);
        await client.query('INSERT INTO app_migrations (id) VALUES ($1)', [
          migration.id,
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [migrationLock]);
  }
}

export async function verifyMigrations(client: ClientBase): Promise<void> {
  let applied: string[];
  try {
    const result = await client.query<{ id: string }>(
      'SELECT id FROM app_migrations ORDER BY id',
    );
    applied = result.rows.map(({ id }) => id);
  } catch (error) {
    if ((error as { code?: string }).code !== '42P01') throw error;
    throw new Error('Database migrations have not been applied', {
      cause: error,
    });
  }

  const expected = migrations.map(({ id }) => id);
  if (
    applied.length !== expected.length ||
    applied.some((id, index) => id !== expected[index])
  ) {
    throw new Error('Database migration version does not match this release');
  }
}

export async function grantRuntimeAccess(
  client: ClientBase,
  runtimeRole: string,
): Promise<void> {
  if (!/^[a-z_][a-z0-9_-]{0,62}$/i.test(runtimeRole)) {
    throw new Error('Runtime database role has an invalid identifier');
  }
  const role = await client.query<{
    rolbypassrls: boolean;
    rolsuper: boolean;
  }>('SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = $1', [
    runtimeRole,
  ]);
  const attributes = role.rows[0];
  if (!attributes) throw new Error('Runtime database role does not exist');
  if (attributes.rolsuper || attributes.rolbypassrls) {
    throw new Error('Runtime database role must not bypass row security');
  }

  const identifier = `"${runtimeRole.replaceAll('"', '""')}"`;
  await client.query(`GRANT USAGE ON SCHEMA public TO ${identifier}`);
  await client.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${identifier}`,
  );
  await client.query(
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${identifier}`,
  );
  await client.query(
    `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${identifier}`,
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${identifier}`,
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${identifier}`,
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ${identifier}`,
  );
}
