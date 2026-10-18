import { defineConfig, devices } from '@playwright/test';

const PORT = 8090;

export default defineConfig({
  testDir: './test',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'phone', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
  ],
  webServer: {
    // Each run gets a fresh database, seeded users and live fake Signal K data.
    command: 'pnpm --filter @watchkeeper/server exec tsx test/e2e-server.ts',
    url: `http://127.0.0.1:${PORT}/api/v1/setup/status`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { PORT: String(PORT) },
  },
});
