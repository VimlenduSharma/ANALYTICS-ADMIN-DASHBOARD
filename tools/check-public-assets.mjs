import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const browserRoot = join(process.cwd(), 'dist/apps/web/browser');
const secretNames = [
  'CREDENTIAL_ENCRYPTION_KEY',
  'DATABASE_URL',
  'METRICS_BEARER_TOKEN',
  'OIDC_CLIENT_SECRET',
  'POSTGRES_PASSWORD',
  'REDIS_URL',
  'WEBHOOK_SIGNING_KEY',
];
const secrets = secretNames
  .map((name) => [name, process.env[name]])
  .filter(([, value]) => value && value.length > 0);

async function inspect(directory) {
  let checked = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      checked += await inspect(path);
      continue;
    }
    if (!entry.isFile()) continue;
    if (path.endsWith('.map')) throw new Error('Public source map found');
    const asset = await readFile(path);
    if (
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(asset.toString())
    )
      throw new Error(`Private key material found in ${path}`);
    for (const [name, value] of secrets) {
      if (asset.includes(value))
        throw new Error(`${name} value found in public asset ${path}`);
    }
    checked++;
  }
  return checked;
}

try {
  const checked = await inspect(browserRoot);
  if (!checked) throw new Error('Browser build has no public assets');
  console.log(
    `Checked ${checked} public assets against ${secrets.length} configured secrets.`,
  );
} catch (error) {
  console.error(
    error instanceof Error ? error.message : 'Public asset check failed',
  );
  process.exitCode = 1;
}
