// Database connection pool monitoring and verification for Phase 4.1 multi-tenant
// performance hardening. Tracks connection acquisition time, pool utilization,
// and slow queries to ensure the database layer stays healthy under load.

import { prisma } from '@acaos/backend-core/lib/prisma.js'
import { logger } from '@acaos/backend-core/lib/logger.js'

export type PoolMetrics = {
  poolSize: number
  activeConnections: number
  idleConnections: number
  waitingRequests: number
  utilization: number
}

export type QueryMetrics = {
  totalQueries: number
  slowQueries: number
  avgDurationMs: number
  maxDurationMs: number
}

interface QueryLog {
  timestamp: number
  durationMs: number
  query: string
}

// Per-service queryLog for slow-query tracking (one per deployment pod).
// Kept small (100 entries max) to avoid memory bloat.
const queryLog: QueryLog[] = []
const QUERY_LOG_MAX = 100
const SLOW_QUERY_THRESHOLD_MS = 500 // Queries >500ms are slow in multi-tenant

/**
 * Verify database connectivity and connection pool health.
 * Returns metrics about the pool state. Non-blocking; safe to call frequently.
 */
export async function verifyDatabasePool(): Promise<PoolMetrics> {
  try {
    // Simple query to verify connectivity and timing
    const start = Date.now()
    const result = await prisma.$queryRaw<[{ now: Date }]>`SELECT NOW()`
    const durationMs = Date.now() - start

    // Log query for monitoring
    recordQuery('SELECT NOW()', durationMs)

    // Prisma doesn't expose detailed pool metrics directly, but we can estimate
    // utilization from the default connection limit and query duration.
    const poolSize = Number(process.env.DB_POOL_SIZE || 10)

    return {
      poolSize,
      activeConnections: durationMs > 100 ? Math.ceil(poolSize * 0.5) : 1, // Estimate
      idleConnections: poolSize - 1,
      waitingRequests: 0,
      utilization: durationMs > 500 ? 0.8 : 0.2, // Estimate based on latency
    }
  } catch (err) {
    logger.error('database pool verification failed', { error: (err as Error).message })
    return {
      poolSize: 0,
      activeConnections: 0,
      idleConnections: 0,
      waitingRequests: 0,
      utilization: 0,
    }
  }
}

/**
 * Record a query for slow-query analysis. Kept in-memory for performance;
 * production monitoring should hook into Prisma's middleware for detailed metrics.
 */
function recordQuery(query: string, durationMs: number): void {
  queryLog.push({ timestamp: Date.now(), durationMs, query })
  if (queryLog.length > QUERY_LOG_MAX) queryLog.shift()

  // Warn on slow queries; check the threshold
  if (durationMs > SLOW_QUERY_THRESHOLD_MS) {
    logger.warn('slow query detected', { query: query.slice(0, 100), durationMs })
  }
}

/**
 * Get recent query performance metrics for this pod.
 * Useful for detecting local bottlenecks (high-contention queries, missing indexes).
 */
export function getQueryMetrics(): QueryMetrics {
  if (queryLog.length === 0) {
    return { totalQueries: 0, slowQueries: 0, avgDurationMs: 0, maxDurationMs: 0 }
  }

  const slowQueries = queryLog.filter((q) => q.durationMs > SLOW_QUERY_THRESHOLD_MS).length
  const totalDuration = queryLog.reduce((sum, q) => sum + q.durationMs, 0)
  const maxDuration = Math.max(...queryLog.map((q) => q.durationMs))

  return {
    totalQueries: queryLog.length,
    slowQueries,
    avgDurationMs: Math.round(totalDuration / queryLog.length),
    maxDurationMs: maxDuration,
  }
}

/**
 * Periodic health check: verify pool is responsive and log utilization.
 * Call this every 30-60 seconds from a background task or server startup.
 */
export async function logPoolHealth(): Promise<void> {
  const metrics = await verifyDatabasePool()
  const queryMetrics = getQueryMetrics()

  logger.info('database pool health', {
    pool: metrics,
    queryMetrics,
    threshold: SLOW_QUERY_THRESHOLD_MS,
  })
}
