import { defineConfig } from '@playwright/test'

// Local-only full-stack run of the technician-to-manager photo workflow. Everything it talks to is started by
// scripts/e2e-evidence-local.sh on loopback (Postgres, Redis, API, worker, a throwaway S3-compatible server,
// and the PRODUCTION web build behind the production CSP). It is deliberately not part of the default config
// and needs no provider account. Run: npm run e2e:evidence-local
export default defineConfig({
  testDir: './e2e',
  testMatch: /evidence-workflow\.spec\.ts/,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
    ...(process.env.ACAOS_CHROMIUM ? { launchOptions: { executablePath: process.env.ACAOS_CHROMIUM } } : {}),
  },
})
