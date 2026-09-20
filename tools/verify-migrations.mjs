import { createRequire } from 'node:module';
import { Client } from 'pg';

const require = createRequire(import.meta.url);
const {
  verifyMigrations,
} = require('../dist/libs/data-core/src/lib/migration-gate.js');
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');

const client = new Client({
  application_name: 'analytics-migration-verifier',
  connectionString,
  connectionTimeoutMillis: 10_000,
});

try {
  await client.connect();
  await verifyMigrations(client);
  console.log('Database schema matches this release.');
} finally {
  await client.end();
}
