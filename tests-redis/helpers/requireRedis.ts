// Redis prerequisite guard for the Redis-backed test tier. Imported FIRST by the
// Redis helpers so a missing REDIS_URL fails with a Redis-specific message before
// any database fixture (which would otherwise throw a DATABASE_URL error first).
if (!process.env.REDIS_URL) {
  throw new Error('REDIS_URL is required for the Redis-backed test tier (see npm run test:redis:local).')
}
