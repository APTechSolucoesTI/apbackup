import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  timeout: 45000,
  use: {
    baseURL: 'http://127.0.0.1:4312',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'pnpm exec tsx packages/db/src/dev.ts',
      url: 'http://127.0.0.1:4312/health',
      reuseExistingServer: false,
      timeout: 30000,
      env: { PORT: '4312' },
    },
    {
      command: 'pnpm --filter @apbackup/web dev',
      url: 'http://127.0.0.1:4320/login',
      reuseExistingServer: false,
      timeout: 90000,
      env: {
        PORT: '4320',
        DATABASE_URL: process.env.TEST_DATABASE_URL ?? '',
        AUTH_SECRET: 'disposable-browser-secret-for-tests-only-48-chars',
        AUTH_BASE_URL: 'http://127.0.0.1:4320',
        VAULT_KEY_BASE64: Buffer.alloc(32, 7).toString('base64'),
        VAULT_KEY_REFERENCE: 'disposable-browser-vault-v1',
        POSTGRES_ALLOWED_HOSTS: '127.0.0.1',
      },
    },
  ],
});
