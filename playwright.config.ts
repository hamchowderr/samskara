import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// E2E runs against the real dev server on its own port and a throwaway
// database, so it never touches data/samskara.db or a dev server on 4111.
const PORT = 4199;
const BASE_URL = `http://localhost:${PORT}`;
const dbDir = mkdtempSync(join(tmpdir(), 'samskara-e2e-'));

export default defineConfig({
  testDir: 'e2e',
  // One flow, several browser contexts, one shared server and database.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'npm run dev',
    url: `${BASE_URL}/auth/me`,
    // A fresh database needs migrations and a first bundle.
    timeout: 300_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    env: {
      PORT: String(PORT),
      MASTRA_DB_PATH: join(dbDir, 'e2e.db').replace(/\\/g, '/'),
      // Better Auth trusts only its own origin. .env points this at the
      // public tunnel, which the browser here is not on.
      MASTRACODE_PUBLIC_URL: BASE_URL,
      // No mail is sent in E2E; invitations are read back from the API.
      RESEND_API_KEY: '',
    },
  },
});
