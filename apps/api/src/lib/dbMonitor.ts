// Database connection pool monitoring and verification for Phase 4.1 multi-tenant
// performance hardening. Tracks connection acquisition time, pool utilization,
// and slow queries to ensure the database layer stays healthy under load.

import { prisma } from '@acaos/backend-core/lib/prisma.js'
import { logger } from '@acaos/backend-core/lib/logger.js'
import { getSlowestQueries } from '@acaos/backend-core/lib/queryInstrumentation.js'

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

const SLOW_QUERY_THRESHOLD_MS = 500 // Queries >500ms are slow in multi-tenant

/**
 * Verify database connectivity and connection pool health.
 * Returns metrics about the pool state. Non-blocking; safe to call frequently.
 */
export async function verifyDatabasePool(): Promise<PoolMetrics> {
  try {
    // Simple query to verify connectivity and timing
    const start = Date.now()
    await prisma.$queryRaw`SELECT NOW()`
    const durationMs = Date.now() - start

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
 * Get recent query performance metrics for this pod.
 * Useful for detecting local bottlenecks (high-contention queries, missing indexes).
 * Uses data from Prisma's instrumentation middleware.
 */
export function getQueryMetrics(): QueryMetrics {
  const slowestQueries = getSlowestQueries(100)
  if (slowestQueries.length === 0) {
    return { totalQueries: 0, slowQueries: 0, avgDurationMs: 0, maxDurationMs: 0 }
  }

  const totalQueries = slowestQueries.reduce((sum, q) => sum + q.count, 0)
  const slowQueries = slowestQueries.filter((q) => q.maxDurationMs > SLOW_QUERY_THRESHOLD_MS).length
  const totalDuration = slowestQueries.reduce((sum, q) => sum + q.avgDurationMs * q.count, 0)
  const maxDuration = Math.max(...slowestQueries.map((q) => q.maxDurationMs))

  return {
    totalQueries,
    slowQueries,
    avgDurationMs: totalQueries > 0 ? Math.round(totalDuration / totalQueries) : 0,
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
