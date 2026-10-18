import { defineConfig, devices } from '@playwright/test';

const PORT = 8090;
// A random ingress-style prefix per run, shared with the test server and workers via the environment.
process.env.INGRESS_PREFIX ??= `/api/hassio_ingress/${Math.random().toString(36).slice(2, 14)}`;
const PREFIX = process.env.INGRESS_PREFIX;

export default defineConfig({
  testDir: './test',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    // Relative goto('settings') resolves under the prefix, like the app's own links.
    baseURL: `http://127.0.0.1:${PORT}${PREFIX}/`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'phone', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
  ],
  webServer: {
    // Fresh database, seeded HA users, live fake Signal K, and an ingress proxy in front.
    command: 'pnpm --filter @watchkeeper/server exec tsx test/e2e-server.ts',
    url: `http://127.0.0.1:${PORT + 1}/api/v1/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { PORT: String(PORT), INGRESS_PREFIX: PREFIX },
  },
});
