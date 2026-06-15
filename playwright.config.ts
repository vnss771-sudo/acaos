import { defineConfig } from '@playwright/test'

// ── E2E infrastructure config ────────────────────────────────────────────────
// These smoke tests boot the real API + web (Vite) servers and drive the actual
// browser UI against them. They deliberately exercise the frontend->backend
// contract, which the unit suites cannot: backend route tests build request
// bodies themselves, so a frontend that omits a required field still passes them.
//
// Postgres + Redis must be reachable. Defaults target the same local instances
// the rest of the repo's integration tests use; override via env in CI.
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ||
  'postgresql://postgres:postgres@127.0.0.1:5432/acaos_test'
const REDIS_URL = process.env.E2E_REDIS_URL || 'redis://127.0.0.1:6379'

// Make the DB reachable to the test process itself (the email-verification
// helper talks to Postgres directly via Prisma) as well as to the spawned API.
process.env.DATABASE_URL = DATABASE_URL
process.env.DIRECT_URL = DATABASE_URL
process.env.REDIS_URL = REDIS_URL

// Shared env for the API/web servers Playwright launches.
const serverEnv = {
  ...process.env,
  NODE_ENV: 'development',
  DATABASE_URL,
  DIRECT_URL: DATABASE_URL,
  REDIS_URL,
  PORT: '4000',
} as Record<string, string>

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  // Boot is the slow part; keep per-test timeouts sane but allow for cold starts.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      // API on :4000. The worker is intentionally NOT started — all three flows
      // assert on synchronous responses (seed and AI are inline; campaign launch
      // asserts on the 202 enqueue ack, which fires before any job runs).
      command: 'npm run start:dev -w @acaos/api',
      url: 'http://localhost:4000/api/live',
      env: serverEnv,
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // Vite dev server on :5173 proxies /api -> http://localhost:4000.
      command: 'npm run dev -w @acaos/web',
      url: 'http://localhost:5173',
      env: serverEnv,
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
})
