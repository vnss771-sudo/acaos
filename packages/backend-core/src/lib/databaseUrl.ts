// Computes the Postgres connection URL Prisma actually connects with — never
// process.env.DATABASE_URL itself, so other code that reads that var directly
// is unaffected.
//
// R4 (Phase 1) warns in production when DATABASE_URL has no `connection_limit`
// query param, since Prisma's default pool size (num_cpus*2+1 per process) is
// unbounded across replicas and a real risk against Postgres max_connections.
// This goes further: when the operator hasn't set one explicitly, a sane
// default is computed and appended here so the pool is bounded even if nobody
// reads the warning. An operator-set `connection_limit` is always left
// untouched — this only fills in a gap, never overrides a deliberate choice.

export const DEFAULT_CONNECTION_LIMIT = 10

// DB_POOL_SIZE lets an operator size the pool per replica (e.g. to match
// WEB_CONCURRENCY, a worker's queue concurrency, or PgBouncer capacity) without
// having to hand-edit the connection string. Invalid/absent values fall back
// to DEFAULT_CONNECTION_LIMIT.
export function withDefaultConnectionLimit(rawUrl: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!rawUrl) return rawUrl
  if (/[?&]connection_limit=/.test(rawUrl)) return rawUrl

  const configured = Number(env.DB_POOL_SIZE)
  const limit = Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_CONNECTION_LIMIT

  const separator = rawUrl.includes('?') ? '&' : '?'
  return `${rawUrl}${separator}connection_limit=${limit}`
}
