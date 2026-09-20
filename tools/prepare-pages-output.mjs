import { copyFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const output = join(process.cwd(), 'dist/apps/web/browser');
const index = join(output, 'index.html');

await copyFile(index, join(output, '404.html'));

for (const requiredAsset of ['_headers', '_redirects', '_routes.json']) {
  await readFile(join(output, requiredAsset));
}

console.log('Cloudflare Pages output prepared.');
