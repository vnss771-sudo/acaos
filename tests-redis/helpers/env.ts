// Helpers for the Redis + PostgreSQL backed test tier.
//
// Exercises the real BullMQ queue integration (enqueue → poll job state) end to
// end against a live Redis, plus the real Prisma layer. Requires both
// DATABASE_URL and REDIS_URL; provisioned by scripts/test-redis-local.sh
// locally and the `verify-redis` CI job.
//
// The Redis preflight import comes BEFORE the database fixtures so a missing
// REDIS_URL fails with the Redis-specific message first (the DB fixture import
// throws on a missing DATABASE_URL at load time).

import './requireRedis.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace } from '../../tests-db/helpers/db.ts'
import { flushRedis } from './redis.ts'

export { prisma, resetDb, disconnect, seedUserWithWorkspace }
export { startTestServer, bearer, type TestServer } from '../../tests/helpers/integration.ts'
export { flushRedis }

/** Reset both backing stores between tests. */
export async function resetAll(): Promise<void> {
  await resetDb()
  await flushRedis()
}
