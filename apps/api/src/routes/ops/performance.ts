import { Router } from 'express'
import { asyncHandler } from '../../lib/http.js'
import { verifyDatabasePool, getQueryMetrics } from '../../lib/dbMonitor.js'
import { getWorkspaceCacheStats } from '../../lib/workspaceCache.js'
import { getWorkspaceQueryDistribution } from '../../lib/workspaceIsolation.js'

// Multi-tenant performance metrics endpoint. Phase 4.1 operational visibility.
// Aggregates database pool health, query performance, caching efficiency, and
// workspace load distribution to detect performance bottlenecks.
//
// Endpoint: GET /api/ops/performance
// Auth: Metrics token (same as /metrics endpoint)
// Returns: Pool metrics, query times, cache stats, workspace hotspots

export const performanceRouter = Router()

performanceRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const [poolMetrics, queryMetrics, cacheStats, workspaceDistribution] = await Promise.all([
      verifyDatabasePool(),
      Promise.resolve(getQueryMetrics()),
      Promise.resolve(getWorkspaceCacheStats()),
      Promise.resolve(getWorkspaceQueryDistribution()),
    ])

    res.json({
      timestamp: new Date().toISOString(),
      database: {
        pool: poolMetrics,
        queries: queryMetrics,
      },
      caching: cacheStats,
      workspaces: {
        topByQueryCount: workspaceDistribution.slice(0, 10).map(([wsId, count]) => ({
          workspaceId: wsId,
          queryCount: count,
        })),
      },
      thresholds: {
        slowQueryMs: 500,
        poolUtilizationWarning: 0.8,
        poolUtilizationCritical: 0.95,
      },
    })
  })
)

/**
 * GET /api/ops/performance/pool — Database connection pool details.
 * Returns current pool state and capacity.
 */
performanceRouter.get(
  '/pool',
  asyncHandler(async (_req, res) => {
    const metrics = await verifyDatabasePool()
    const poolSize = Number(process.env.DB_POOL_SIZE || 10)
    const recommendation = metrics.utilization > 0.8
      ? `Increase DB_POOL_SIZE above ${poolSize} — pool is ${(metrics.utilization * 100).toFixed(0)}% utilized`
      : `Pool health OK — ${(metrics.utilization * 100).toFixed(0)}% utilized`

    res.json({
      metrics,
      poolSizeConfigured: poolSize,
      recommendation,
      envVar: 'DB_POOL_SIZE',
    })
  })
)

/**
 * GET /api/ops/performance/queries — Recent slow query log.
 * Helps identify missing indexes or query optimization opportunities.
 */
performanceRouter.get(
  '/queries',
  asyncHandler(async (_req, res) => {
    const metrics = getQueryMetrics()
    const slowQueryPercentage = metrics.totalQueries > 0
      ? (metrics.slowQueries / metrics.totalQueries * 100).toFixed(1)
      : '0'

    res.json({
      metrics,
      slowQueryPercentage,
      slowQueryThresholdMs: 500,
      recommendation: metrics.slowQueries > 5
        ? 'Investigate slow queries — check logs for query names and consider indexing'
        : 'Query performance OK',
    })
  })
)

/**
 * GET /api/ops/performance/cache — Workspace cache hit rate and effectiveness.
 * Shows how much DB pressure is being relieved by caching.
 */
performanceRouter.get(
  '/cache',
  asyncHandler(async (_req, res) => {
    const stats = getWorkspaceCacheStats()
    res.json({
      localCacheSize: stats.localSize,
      cacheTtlMs: 5 * 60 * 1000,
      recommendation: stats.localSize > 1000
        ? 'Local cache growing large — verify Redis is working for distributed cache'
        : 'Cache size nominal',
      tuning: {
        envVars: ['REDIS_URL for distributed cache, TTL hardcoded to 5 min'],
      },
    })
  })
)

/**
 * GET /api/ops/performance/workspaces — Top workspaces by query load.
 * Identifies workspaces that consume disproportionate resources.
 * Useful for detecting abuse patterns or legitimate high-activity customers.
 */
performanceRouter.get(
  '/workspaces',
  asyncHandler(async (_req, res) => {
    const distribution = getWorkspaceQueryDistribution()
    const totalQueries = distribution.reduce((sum, [, count]) => sum + count, 0)
    const avgPerWorkspace = totalQueries / Math.max(1, distribution.length)

    const hotspots = distribution
      .filter(([, count]) => count > avgPerWorkspace * 2) // >2x average
      .map(([wsId, count]) => ({
        workspaceId: wsId,
        queryCount: count,
        percentageOfTotal: ((count / totalQueries) * 100).toFixed(1),
      }))

    res.json({
      totalDistributed: distribution.length,
      totalQueries,
      avgPerWorkspace: Math.round(avgPerWorkspace),
      hotspots,
      recommendation: hotspots.length > 0
        ? `Monitor hotspots — consider rate limiting or workspace-specific tuning`
        : 'Load distribution even across workspaces',
    })
  })
)
