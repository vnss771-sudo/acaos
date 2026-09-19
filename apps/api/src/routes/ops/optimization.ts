// Phase 4.2: Query optimization and indexing endpoints
// Provides operators with actionable recommendations to improve performance:
// - Index recommendations (by impact)
// - Query optimization opportunities (N+1, full scans, projections)
// - Code examples for common patterns
// - Index migration scripts

import { Router } from 'express'
import { asyncHandler } from '../../lib/http.js'
import {
  generateIndexRecommendations,
  getPostgresIndexSQL,
  getIndexMigrationSQL,
  prioritizeIndexes,
} from '@acaos/backend-core/lib/indexRecommendation.js'
import {
  getAllOptimizations,
  getCodeExamples,
} from '@acaos/backend-core/lib/queryOptimization.js'
import { getCacheStats } from '@acaos/backend-core/lib/queryResultCache.js'

export const optimizationRouter = Router()

/**
 * GET /api/ops/optimization/indexes — Top recommended indexes by impact.
 * Ranked by (frequency × speedup), high-priority first.
 */
optimizationRouter.get(
  '/indexes',
  asyncHandler(async (_req, res) => {
    const recommendations = prioritizeIndexes()

    res.json({
      summary: {
        totalRecommendations: recommendations.length,
        estimatedTotalSpeedup: recommendations.reduce((sum, r) => sum + r.estimatedSpeedupMs, 0),
        highPriority: recommendations.filter((r) => r.priority === 'high').length,
      },
      recommendations: recommendations.map((rec) => ({
        model: rec.model,
        operation: rec.operation,
        fields: rec.fields,
        priority: rec.priority,
        rationale: rec.rationale,
        estimatedSpeedupMs: rec.estimatedSpeedupMs,
        frequency: rec.frequency,
        impactScore: (rec.frequency * rec.estimatedSpeedupMs).toFixed(0),
      })),
      nextSteps: [
        '1. Review recommendations by priority',
        '2. Generate Prisma migration or raw SQL (see /migration endpoint)',
        '3. Apply during low-traffic window',
        '4. Re-run load tests to measure impact',
      ],
    })
  })
)

/**
 * GET /api/ops/optimization/indexes/:model/:operation/migration
 * Get Prisma migration code for a specific index.
 */
optimizationRouter.get(
  '/indexes/:model/:operation/migration',
  asyncHandler(async (req, res) => {
    const { model, operation } = req.params
    const recommendations = generateIndexRecommendations()
    const rec = recommendations.find((r) => r.model === model && r.operation === operation)

    if (!rec) {
      return res.status(404).json({ error: 'No recommendation found for this query' })
    }

    res.json({
      recommendation: rec,
      prismaMigration: getIndexMigrationSQL(rec),
      postgresSQL: getPostgresIndexSQL(rec),
      testQuery: `
ANALYZE;
EXPLAIN ANALYZE
SELECT * FROM "${model}"
WHERE ${rec.fields.map((f) => `"${f}" = ...`).join(' AND ')};
      `.trim(),
    })
  })
)

/**
 * GET /api/ops/optimization/queries — All query optimization opportunities.
 * Ranked by estimated impact.
 */
optimizationRouter.get(
  '/queries',
  asyncHandler(async (_req, res) => {
    const opportunities = getAllOptimizations()

    // Group by type
    const byType = opportunities.reduce(
      (acc, opp) => {
        if (!acc[opp.type]) acc[opp.type] = []
        acc[opp.type].push(opp)
        return acc
      },
      {} as Record<string, typeof opportunities>
    )

    res.json({
      summary: {
        totalOpportunities: opportunities.length,
        byType: Object.fromEntries(Object.entries(byType).map(([type, opps]) => [type, opps.length])),
      },
      topIssues: opportunities.slice(0, 5).map((opp) => ({
        type: opp.type,
        model: opp.model,
        description: opp.description,
        estimatedSavings: opp.estimatedSavings,
      })),
      allOpportunities: opportunities.map((opp) => ({
        type: opp.type,
        model: opp.model,
        operation: opp.operation,
        description: opp.description,
        currentImpact: opp.currentImpact,
        recommendation: opp.recommendation,
        estimatedSavings: opp.estimatedSavings,
      })),
    })
  })
)

/**
 * GET /api/ops/optimization/code-examples — Code patterns for common optimizations.
 */
optimizationRouter.get(
  '/code-examples',
  asyncHandler(async (_req, res) => {
    const examples = getCodeExamples()

    res.json({
      total: examples.length,
      examples: examples.map((ex) => ({
        pattern: ex.pattern,
        inefficient: ex.inefficient,
        optimized: ex.optimized,
        savings: ex.savings,
      })),
      disclaimer:
        'These are generic examples. Your actual implementation may vary based on business logic.',
    })
  })
)

/**
 * GET /api/ops/optimization/cache — Cache effectiveness and statistics.
 */
optimizationRouter.get(
  '/cache',
  asyncHandler(async (_req, res) => {
    const stats = getCacheStats()

    res.json({
      cacheStats: stats,
      recommendation:
        stats.validEntries > 1000
          ? 'Cache is large — verify TTLs and consider external cache'
          : 'Cache size nominal',
      tuning: {
        inProcessMaxEntries: 10000,
        ttlMs: {
          workspace: '5 min',
          lists: '2 min',
          aggregations: '1 min',
        },
        redisRequired: process.env.REDIS_URL ? true : false,
      },
    })
  })
)

/**
 * GET /api/ops/optimization/summary — Overall optimization readiness.
 */
optimizationRouter.get(
  '/summary',
  asyncHandler(async (_req, res) => {
    const indexes = prioritizeIndexes()
    const opportunities = getAllOptimizations()
    const cacheStats = getCacheStats()

    const healthScore =
      (indexes.length === 0 ? 20 : 0) +
      (opportunities.length === 0 ? 20 : 0) +
      (cacheStats.validEntries > 100 ? 20 : 10) +
      (cacheStats.totalHits > 1000 ? 20 : 10) +
      (cacheStats.estimatedMemoryMB < 50 ? 20 : 10)

    res.json({
      healthScore: Math.min(100, healthScore),
      readiness:
        healthScore >= 80
          ? 'production-ready'
          : healthScore >= 60
            ? 'needs-attention'
            : 'needs-major-work',
      breakdown: {
        indexing: {
          status: indexes.length === 0 ? 'optimized' : `${indexes.length} recommendations`,
          topPriority: indexes[0]?.rationale || 'None',
        },
        queries: {
          status: opportunities.length === 0 ? 'optimized' : `${opportunities.length} issues found`,
          topIssue: opportunities[0]?.description || 'None',
        },
        caching: {
          status: cacheStats.validEntries > 0 ? 'active' : 'not-in-use',
          hitRate: cacheStats.totalHits > 0 ? 'hits-tracked' : 'warming-up',
        },
      },
      actionItems: [
        ...(indexes.length > 0 ? [`Apply ${indexes.length} index recommendations`] : []),
        ...(opportunities.length > 0 ? [`Address ${opportunities.length} query issues`] : []),
        ...(cacheStats.estimatedMemoryMB > 100 ? ['Monitor cache memory growth'] : []),
      ],
    })
  })
)
