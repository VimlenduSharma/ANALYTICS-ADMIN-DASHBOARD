import { defineConfig, devices } from '@playwright/test';
import { nxE2EPreset } from '@nx/playwright/preset';
import { workspaceRoot } from '@nx/devkit';

const baseURL = process.env['BASE_URL'] || 'http://localhost:4200';
const node = `"${process.execPath}"`;
const webServerTimeout = 180_000;

export default defineConfig({
  ...nxE2EPreset(import.meta.dirname, { testDir: './src' }),
  expect: { timeout: 8_000 },
  globalTeardown: './src/global-teardown.ts',
  retries: process.env['CI'] ? 2 : 0,
  timeout: 30_000,
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  webServer: [
    {
      command: `${node} apps/web-e2e/src/oidc-provider.mjs`,
      url: 'http://127.0.0.1:4300/health',
      reuseExistingServer: false,
      cwd: workspaceRoot,
      timeout: webServerTimeout,
    },
    {
      command: `${node} tools/run-nx.mjs serve api`,
      url: 'http://127.0.0.1:3000/api/v1/health/live',
      reuseExistingServer: false,
      cwd: workspaceRoot,
      timeout: webServerTimeout,
      env: {
        NODE_ENV: 'test',
        OIDC_CLIENT_ID: 'analytics-admin-e2e',
        OIDC_CLIENT_SECRET: 'browser-test-only-secret',
        OIDC_ISSUER_URL: 'http://127.0.0.1:4300',
        OIDC_REDIRECT_URI: 'http://localhost:4200/api/v1/auth/callback',
        RATE_LIMIT_AUTH_MAX: '1000',
        WEB_ORIGIN: 'http://localhost:4200',
      },
    },
    {
      command: `${node} tools/run-nx.mjs serve web`,
      url: 'http://localhost:4200',
      reuseExistingServer: false,
      cwd: workspaceRoot,
      timeout: webServerTimeout,
    },
  ],
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile-chromium',
      use: { ...devices['Pixel 7'] },
    },
    {
      name: 'tablet-chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { height: 768, width: 1024 },
      },
    },
  ],
});
