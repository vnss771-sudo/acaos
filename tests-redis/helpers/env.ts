// Helpers for the Redis + PostgreSQL backed test tier.
//
// Exercises the real BullMQ queue integration (enqueue → poll job state) end to
// end against a live Redis, plus the real Prisma layer. Requires both
// DATABASE_URL and REDIS_URL; provisioned by scripts/test-redis-local.sh
// locally and the `verify-redis` CI job.

import IORedis from 'ioredis'
import { prisma, resetDb, disconnect, seedUserWithWorkspace } from '../../tests-db/helpers/db.ts'

export { prisma, resetDb, disconnect, seedUserWithWorkspace }
export { startTestServer, bearer, type TestServer } from '../../tests/helpers/integration.ts'

if (!process.env.REDIS_URL) {
  throw new Error('REDIS_URL is required for the Redis-backed test tier (see npm run test:redis:local).')
}

/** Clear all queued jobs so each test starts from an empty Redis. */
export async function flushRedis(): Promise<void> {
  const client = new IORedis(process.env.REDIS_URL as string, { maxRetriesPerRequest: null })
  await client.flushdb()
  await client.quit()
}

/** Reset both backing stores between tests. */
export async function resetAll(): Promise<void> {
  await resetDb()
  await flushRedis()
}
