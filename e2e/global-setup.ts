import { execSync } from 'node:child_process'

// Ensure the e2e database schema is up to date before any test runs. Idempotent:
// `migrate deploy` is a no-op when the database already matches the migration
// history, so re-running the suite is cheap.
export default async function globalSetup() {
  const DATABASE_URL = process.env.DATABASE_URL!
  // eslint-disable-next-line no-console
  console.log(`[e2e] applying migrations to ${DATABASE_URL.replace(/:[^:@/]+@/, ':***@')}`)
  execSync('npx prisma migrate deploy --schema packages/db/prisma/schema.prisma', {
    stdio: 'inherit',
    env: { ...process.env, DIRECT_URL: DATABASE_URL },
  })
}
