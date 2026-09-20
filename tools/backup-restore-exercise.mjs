import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sourceDatabase = required('POSTGRES_DB');
const user = required('POSTGRES_USER');
const restoreDatabase = `analytics_restore_${randomBytes(6).toString('hex')}`;
const workingDirectory = await mkdtemp(join(tmpdir(), 'analytics-backup-'));
const backupPath = join(workingDirectory, 'analytics.dump');
const tables = ['app_migrations', 'organizations', 'orders', 'audit_events'];

try {
  await dumpDatabase();
  await composeExec([
    'psql',
    '-U',
    user,
    '-d',
    'postgres',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    `CREATE DATABASE "${restoreDatabase}"`,
  ]);
  await restoreDatabaseDump();

  const sourceState = await databaseState(sourceDatabase);
  const restoredState = await databaseState(restoreDatabase);
  assert.deepEqual(restoredState, sourceState);
  const restoredCounts = Object.fromEntries(
    Object.entries(restoredState).map(([table, state]) => [table, state.count]),
  );
  assert.ok(
    sourceState.app_migrations?.count > 0,
    'Expected applied migrations in backup',
  );

  const backup = await stat(backupPath);
  console.log(
    JSON.stringify(
      {
        backupBytes: backup.size,
        fingerprints: Object.fromEntries(
          Object.entries(restoredState).map(([table, state]) => [
            table,
            state.fingerprint,
          ]),
        ),
        restoredCounts,
        status: 'passed',
        tablesVerified: tables,
      },
      null,
      2,
    ),
  );
} finally {
  await composeExec([
    'psql',
    '-U',
    user,
    '-d',
    'postgres',
    '-c',
    `DROP DATABASE IF EXISTS "${restoreDatabase}" WITH (FORCE)`,
  ]).catch(() => undefined);
  await rm(workingDirectory, { force: true, recursive: true });
}

async function dumpDatabase() {
  const output = await open(backupPath, 'wx', 0o600);
  try {
    await run(
      'docker',
      [
        'compose',
        'exec',
        '-T',
        'postgres',
        'pg_dump',
        '-U',
        user,
        '-d',
        sourceDatabase,
        '--format=custom',
        '--no-owner',
        '--no-privileges',
      ],
      output.fd,
    );
  } finally {
    await output.close();
  }

  const backup = await open(backupPath, 'r');
  try {
    const header = Buffer.alloc(5);
    const { bytesRead } = await backup.read(header, 0, header.length, 0);
    assert.equal(bytesRead, header.length, 'Backup archive is incomplete');
    assert.equal(
      header.toString(),
      'PGDMP',
      'Backup archive header is invalid',
    );
  } finally {
    await backup.close();
  }
}

async function restoreDatabaseDump() {
  await run(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      'postgres',
      'pg_restore',
      '-U',
      user,
      '-d',
      restoreDatabase,
      '--exit-on-error',
      '--no-owner',
      '--no-privileges',
    ],
    undefined,
    backupPath,
  );
}

async function databaseState(database) {
  return Object.fromEntries(
    await Promise.all(
      tables.map(async (table) => {
        const query = `
          SELECT count(*)::text,
                 md5(coalesce(string_agg(to_jsonb(row_data)::text, ''
                     ORDER BY to_jsonb(row_data)::text), ''))
          FROM ${table} AS row_data
        `;
        const output = await composeExec([
          'psql',
          '-U',
          user,
          '-d',
          database,
          '-At',
          '-F',
          ',',
          '-v',
          'ON_ERROR_STOP=1',
          '-c',
          query,
        ]);
        const [count = '0', fingerprint = ''] = output.trim().split(',');
        return [table, { count: Number(count), fingerprint }];
      }),
    ),
  );
}

function composeExec(command) {
  return run('docker', ['compose', 'exec', '-T', 'postgres', ...command]);
}

function run(command, args, stdout, stdinPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: [stdinPath ? 'pipe' : 'ignore', stdout ?? 'pipe', 'pipe'],
    });
    const chunks = [];
    const errors = [];
    if (!stdout) child.stdout?.on('data', (chunk) => chunks.push(chunk));
    child.stderr?.on('data', (chunk) => errors.push(chunk));
    if (stdinPath) {
      createReadStream(stdinPath).pipe(child.stdin);
    }
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks).toString());
      else
        reject(
          new Error(Buffer.concat(errors).toString() || `${command} failed`),
        );
    });
  });
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for backup verification`);
  return value;
}
