import { spawn } from 'node:child_process';

for (const suite of [
  'tools/identity-integration.mjs',
  'tools/data-core-integration.mjs',
  'tools/sales-integration.mjs',
  'tools/operations-integration.mjs',
  'tools/governance-integration.mjs',
  'tools/resilience-integration.mjs',
]) {
  const exitCode = await run(suite);
  if (exitCode !== 0) process.exit(exitCode ?? 1);
}

function run(suite) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [suite], {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
    });
    child.once('exit', resolve);
  });
}
