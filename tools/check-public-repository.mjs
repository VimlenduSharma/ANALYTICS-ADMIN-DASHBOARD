import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const tracked = execFileSync('git', ['ls-files', '-z'], {
  encoding: 'utf8',
})
  .split('\0')
  .filter(Boolean);
const forbiddenPaths = [
  /^\.private\//,
  /^\.env(?:$|\.(?!(?:[^/]+\.)?example$))/,
  /^docs\/phases\//,
  /^docs\/(?:DESIGN_STANDARDS|PRE_RELEASE_WEB_STANDARDS|PROJECT_PLAN)\.md$/,
  /(?:^|\/)(?:INTERVIEW|DEMO_RUN|PRIVATE_NOTES)(?:[._-]|$)/i,
  /\.(?:key|p12|pem|pfx|tfstate)$/i,
];
const violations = tracked.filter((path) =>
  forbiddenPaths.some((pattern) => pattern.test(path)),
);

const knownSecrets = [
  'CREDENTIAL_ENCRYPTION_KEY',
  'DATABASE_URL',
  'METRICS_BEARER_TOKEN',
  'OIDC_CLIENT_SECRET',
  'WEBHOOK_SIGNING_KEY',
]
  .map((name) => process.env[name])
  .filter((value) => value && value.length >= 12);
const secretLeaks = [];
for (const path of tracked) {
  if (/\.(?:ico|png)$/i.test(path)) continue;
  const content = readFileSync(path, 'utf8');
  if (knownSecrets.some((secret) => content.includes(secret))) {
    secretLeaks.push(path);
  }
  if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(content)) {
    secretLeaks.push(path);
  }
}

if (violations.length || secretLeaks.length) {
  const details = [
    ...violations.map((path) => `private path is tracked: ${path}`),
    ...[...new Set(secretLeaks)].map(
      (path) => `secret material found: ${path}`,
    ),
  ];
  throw new Error(`Public repository boundary failed:\n${details.join('\n')}`);
}

console.log(`Public repository boundary passed for ${tracked.length} files.`);
