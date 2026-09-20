import { createClient } from '@hey-api/openapi-ts';
import { spawn } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { format, resolveConfig } from 'prettier';

const checkOnly = process.argv.includes('--check');
const port = 33_000 + Math.floor(Math.random() * 1_000);
const baseUrl = `http://127.0.0.1:${port}`;
const specificationPath = 'openapi/analytics-admin.openapi.json';
const clientPath = 'libs/api-client/src/generated';
const output = [];
let temporaryDirectory;
const server = spawn(process.execPath, ['dist/apps/api/main.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    API_HOST: '127.0.0.1',
    API_PORT: String(port),
    NODE_ENV: 'test',
    OIDC_CLIENT_ID: '',
    OIDC_CLIENT_SECRET: '',
    OIDC_ISSUER_URL: '',
    OIDC_REDIRECT_URI: '',
    WEB_ORIGIN: 'http://localhost:4200',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

for (const stream of [server.stdout, server.stderr]) {
  stream.on('data', (chunk) => output.push(String(chunk)));
}

try {
  const document = await waitForDocument();
  const specification = await format(JSON.stringify(sortObject(document)), {
    ...(await resolveConfig(specificationPath)),
    filepath: specificationPath,
  });

  if (checkOnly) {
    await assertCurrent(specificationPath, specification);
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'analytics-openapi-'));
    const generatedPath = join(temporaryDirectory, 'generated');
    await createClient({ input: document, output: generatedPath });
    await removeGeneratedConflictCopies(generatedPath);
    await formatDirectory(generatedPath);
    await assertDirectoryCurrent(clientPath, generatedPath);
    console.log(
      'OpenAPI specification and generated TypeScript client are current.',
    );
  } else {
    await mkdir('openapi', { recursive: true });
    await writeFile(specificationPath, specification);
    await rm(clientPath, { force: true, recursive: true });
    await createClient({ input: document, output: clientPath });
    await removeGeneratedConflictCopies(clientPath);
    await formatDirectory(clientPath);
    console.log(`Generated ${specificationPath} and ${clientPath}.`);
  }
} catch (error) {
  if (output.length) console.error(output.join('').trim());
  throw error;
} finally {
  server.kill('SIGTERM');
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

async function waitForDocument() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`OpenAPI source API exited with code ${server.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/openapi.json`);
      if (response.ok) return response.json();
    } catch {
      // Startup is still in progress.
    }
    await delay(150);
  }
  throw new Error('OpenAPI source API did not become ready within 15 seconds');
}

async function assertCurrent(path, expected) {
  const actual = await readFile(path, 'utf8').catch(() => '');
  if (actual !== expected) {
    throw new Error(`${path} is stale; run pnpm openapi:generate`);
  }
}

async function assertDirectoryCurrent(expectedPath, actualPath) {
  const [expected, actual] = await Promise.all([
    directorySnapshot(expectedPath),
    directorySnapshot(actualPath),
  ]);
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(`${expectedPath} is stale; run pnpm openapi:generate`);
  }
}

async function directorySnapshot(root) {
  const files = [];
  for (const path of await filePaths(root)) {
    files.push([relative(root, path), await readFile(path, 'utf8')]);
  }
  return files;
}

async function formatDirectory(root) {
  for (const path of await filePaths(root)) {
    if (!path.endsWith('.ts')) continue;
    const source = await readFile(path, 'utf8');
    const canonicalPath = join(clientPath, relative(root, path));
    await writeFile(
      path,
      await format(source, {
        ...(await resolveConfig(canonicalPath)),
        filepath: canonicalPath,
      }),
    );
  }
}

async function removeGeneratedConflictCopies(root) {
  const conflictCopy = /(?: \d+\.gen|\.gen \d+)\.ts$/;
  for (const path of await filePaths(root)) {
    if (conflictCopy.test(path)) await rm(path, { force: true });
  }
}

async function filePaths(root) {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else files.push(path);
    }
  }
  await visit(root);
  return files;
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortObject(item)]),
  );
}
