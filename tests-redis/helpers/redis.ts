// Redis-only helpers for tests that do NOT need the PostgreSQL test tier.
//
// Kept separate from ./env.ts on purpose: that helper imports the database-backed
// fixtures (tests-db/helpers/db.ts) for the jobs/SSE integration tests, and that
// import throws if DATABASE_URL is unset. A Redis-only test (e.g. the breaker
// store) that pulled flushRedis from ./env.ts would therefore fail with a
// DATABASE_URL error before the Redis preflight could even run.

import './requireRedis.ts'
import IORedis from 'ioredis'

/** Clear all queued jobs/state so each Redis-backed test starts isolated. */
export async function flushRedis(): Promise<void> {
  const client = new IORedis(process.env.REDIS_URL as string, { maxRetriesPerRequest: null })
  await client.flushdb()
  await client.quit()
}
