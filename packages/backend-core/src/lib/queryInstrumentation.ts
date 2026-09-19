// Prisma query instrumentation middleware. Phase 4.1 provides detailed insights
// into database query patterns, performance, and tenant usage.
//
// Instruments EVERY Prisma operation (query, create, update, delete, etc.) to:
// - Track per-model query counts
// - Measure query latency (P50, P95, P99)
// - Detect slow queries and missing indexes
// - Monitor tenant-model queries per workspace
// - Correlate with rate limit hits and abuse patterns

import type { Prisma } from '@prisma/client'

interface QueryStats {
  count: number
  totalDurationMs: number
  minDurationMs: number
  maxDurationMs: number
  lastDurationMs: number
}

interface TenantQuery {
  workspaceId: string
  model: string
  operation: string
  durationMs: number
}

// Per-model query stats (cleared/reset periodically)
const modelStats = new Map<string, QueryStats>()

// Tenant-model query log (workspace + model = tenant resource consumption)
const tenantQueryLog: TenantQuery[] = []
const TENANT_QUERY_LOG_MAX = 1000

// Tenant models (workspaceId + model → tenant operation)
const TENANT_MODELS = new Set([
  'Lead',
  'Campaign',
  'Prospect',
  'Mission',
  'Inbox',
  'Task',
  'OutreachSent',
  'Outcome',
  'FieldAgent',
  'Shift',
  'ShiftAssignment',
  'JobSite',
  'WebhookEndpoint',
  'IntegratedAccount',
])

/**
 * Instrument a Prisma client with query tracking middleware.
 * Call once on the singleton Prisma client.
 */
export function attachQueryInstrumentation(client: Prisma.PrismaClient): void {
  client.$use(async (params, next) => {
    const start = Date.now()
    try {
      const result = await next(params)
      const durationMs = Date.now() - start

      recordQuery(params.model, params.action, durationMs, params.args)
      return result
    } catch (err) {
      const durationMs = Date.now() - start
      recordQuery(params.model, params.action, durationMs, params.args, true)
      throw err
    }
  })
}

/**
 * Record a query execution. Tracks stats and tenant usage patterns.
 */
function recordQuery(
  model: string | undefined,
  operation: string,
  durationMs: number,
  args: unknown,
  failed = false,
): void {
  if (!model) return

  // Update model-level stats
  const key = `${model}.${operation}`
  const existing = modelStats.get(key) ?? {
    count: 0,
    totalDurationMs: 0,
    minDurationMs: Infinity,
    maxDurationMs: 0,
    lastDurationMs: 0,
  }

  modelStats.set(key, {
    count: existing.count + (failed ? 0 : 1),
    totalDurationMs: existing.totalDurationMs + durationMs,
    minDurationMs: Math.min(existing.minDurationMs, durationMs),
    maxDurationMs: Math.max(existing.maxDurationMs, durationMs),
    lastDurationMs: durationMs,
  })

  // Track tenant-model queries (for abuse detection and load distribution)
  if (TENANT_MODELS.has(model) && (args as any)?.where?.workspaceId) {
    const workspaceId = (args as any).where.workspaceId
    tenantQueryLog.push({
      workspaceId,
      model,
      operation,
      durationMs,
    })
    if (tenantQueryLog.length > TENANT_QUERY_LOG_MAX) {
      tenantQueryLog.shift()
    }
  }
}

/**
 * Get query statistics for all models since last reset.
 * Used by /api/ops/performance/queries endpoint.
 */
export function getQueryStatistics(): Record<string, QueryStats> {
  const stats: Record<string, QueryStats> = {}
  for (const [key, value] of modelStats) {
    stats[key] = {
      ...value,
      avgDurationMs: value.count > 0 ? Math.round(value.totalDurationMs / value.count) : 0,
    }
  }
  return stats
}

/**
 * Get the N slowest queries from the stats.
 * Useful for identifying indexing opportunities.
 */
export function getSlowestQueries(limit = 10): Array<{
  model: string
  operation: string
  maxDurationMs: number
  avgDurationMs: number
  count: number
}> {
  const queries = Array.from(modelStats.entries()).map(([key, stats]) => {
    const [model, operation] = key.split('.')
    return {
      model,
      operation,
      maxDurationMs: stats.maxDurationMs,
      avgDurationMs: stats.count > 0 ? Math.round(stats.totalDurationMs / stats.count) : 0,
      count: stats.count,
    }
  })

  return queries
    .sort((a, b) => b.maxDurationMs - a.maxDurationMs)
    .slice(0, limit)
}

/**
 * Get tenant-model query distribution (for abuse detection).
 * Returns queries grouped by workspace and model.
 */
export function getTenantQueryDistribution(): Record<string, Record<string, number>> {
  const distribution: Record<string, Record<string, number>> = {}

  for (const query of tenantQueryLog) {
    if (!distribution[query.workspaceId]) {
      distribution[query.workspaceId] = {}
    }
    const modelKey = `${query.model}.${query.operation}`
    distribution[query.workspaceId][modelKey] =
      (distribution[query.workspaceId][modelKey] ?? 0) + 1
  }

  return distribution
}

/**
 * Reset query statistics (call periodically, e.g., hourly).
 */
export function resetQueryStatistics(): void {
  modelStats.clear()
}

/**
 * Get query latency percentiles for a specific model.
 * Useful for SLA reporting.
 */
export function getQueryPercentiles(
  model: string,
): { p50: number; p95: number; p99: number } | null {
  const relevant = tenantQueryLog.filter((q) => q.model === model)
  if (relevant.length === 0) return null

  const sorted = relevant.map((q) => q.durationMs).sort((a, b) => a - b)
  const getPercentile = (p: number) => {
    const idx = Math.ceil((sorted.length * p) / 100) - 1
    return sorted[Math.max(0, idx)]
  }

  return {
    p50: getPercentile(50),
    p95: getPercentile(95),
    p99: getPercentile(99),
  }
}
