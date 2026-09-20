import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { Client } from 'pg';

const require = createRequire(import.meta.url);
const {
  applyMigrations,
  verifyMigrations,
} = require('../dist/libs/data-core/src/lib/migration-gate.js');
const { migrations } = require('../dist/libs/data-core/src/lib/migrations.js');
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');

const schema = `release_check_${randomBytes(8).toString('hex')}`;
const client = new Client({ connectionString });
await client.connect();
let created = false;

try {
  await client.query(`CREATE SCHEMA ${schema}`);
  created = true;
  await client.query(`SET search_path TO ${schema}`);
  await assert.rejects(verifyMigrations(client), /not been applied/);
  await applyMigrations(client);
  await verifyMigrations(client);

  const finalMigration = migrations.at(-1);
  assert.ok(finalMigration);
  await client.query('BEGIN');
  try {
    await client.query(finalMigration.down);
    await client.query('DELETE FROM app_migrations WHERE id = $1', [
      finalMigration.id,
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  await assert.rejects(verifyMigrations(client), /does not match/);
  await applyMigrations(client);
  await verifyMigrations(client);
  console.log(
    'Migration gate rejects missing versions and accepts repaired schema.',
  );
} finally {
  await client.query('RESET search_path');
  if (created) await client.query(`DROP SCHEMA ${schema} CASCADE`);
  await client.end();
}
