import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { Pool } from 'pg';
import { createClient } from 'redis';

const testIssuer = 'http://127.0.0.1:4300';

export default async function globalTeardown(): Promise<void> {
  if (!process.env['DATABASE_URL'] && existsSync('.env')) loadEnvFile('.env');

  const databaseUrl = process.env['DATABASE_URL'];
  const redisUrl = process.env['REDIS_URL'];
  if (!databaseUrl || !redisUrl) {
    throw new Error('Browser-test cleanup requires DATABASE_URL and REDIS_URL');
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const redis = createClient({ url: redisUrl });

  try {
    await redis.connect();
    const users = await pool.query<{ id: string }>(
      'SELECT id FROM identity_users WHERE issuer = $1',
      [testIssuer],
    );
    const userIds = users.rows.map(({ id }) => id);
    if (!userIds.length) return;

    for (const userId of userIds) {
      const indexKey = `identity:user-sessions:${userId}`;
      const sessionKeys = await redis.sMembers(indexKey);
      if (sessionKeys.length) await redis.del(sessionKeys);
      await redis.del(indexKey);
    }

    const organizations = await pool.query<{ id: string }>(
      'SELECT id FROM organizations WHERE created_by_user_id = ANY($1::uuid[])',
      [userIds],
    );
    const organizationIds = organizations.rows.map(({ id }) => id);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `
          DELETE FROM audit_events
          WHERE actor_user_id = ANY($1::uuid[])
             OR organization_id = ANY($2::uuid[])
        `,
        [userIds, organizationIds],
      );
      await client.query(
        'DELETE FROM organization_memberships WHERE user_id = ANY($1::uuid[])',
        [userIds],
      );
      if (organizationIds.length) {
        await client.query(
          'DELETE FROM organizations WHERE id = ANY($1::uuid[])',
          [organizationIds],
        );
      }
      await client.query(
        'DELETE FROM identity_users WHERE id = ANY($1::uuid[])',
        [userIds],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } finally {
    if (redis.isOpen) await redis.quit();
    await pool.end();
  }
}
