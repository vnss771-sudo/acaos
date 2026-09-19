// Phase 4.3: Distributed tracing analytics and diagnostics endpoints.
// Exposes span data for performance analysis, bottleneck identification,
// and service dependency mapping.

import { Router } from 'express'
import { asyncHandler } from '../../lib/http.js'
import {
  getSlowestPaths,
  getSlowestDatabaseOps,
  getExternalServiceStats,
  getServiceDependencies,
  identifyBottlenecks,
  getAnalyticsSummary,
} from '@acaos/backend-core/lib/spanAnalytics.js'

export const tracingRouter = Router()

/**
 * GET /api/ops/tracing/summary — Overall tracing statistics.
 * Request volume, error rates, service count.
 */
tracingRouter.get(
  '/summary',
  asyncHandler(async (_req, res) => {
    const summary = getAnalyticsSummary()

    res.json({
      summary,
      recommendation:
        summary.errorRate > 0.05
          ? 'Error rate > 5% — investigate high-error endpoints'
          : summary.averageRequestDurationMs > 500
            ? 'High average latency — review bottleneck analysis'
            : 'Tracing healthy',
    })
  })
)

/**
 * GET /api/ops/tracing/slowest-paths — Endpoints with highest P95 latency.
 * Identifies which API endpoints need optimization.
 */
tracingRouter.get(
  '/slowest-paths',
  asyncHandler(async (_req, res) => {
    const paths = getSlowestPaths(20)

    const critical = paths.filter((p) => p.p95Ms > 1000)
    const warning = paths.filter((p) => p.p95Ms > 500 && p.p95Ms <= 1000)
    const acceptable = paths.filter((p) => p.p95Ms <= 500)

    res.json({
      critical,
      warning,
      acceptable,
      recommendation:
        critical.length > 0
          ? `${critical.length} endpoints with P95 > 1s — urgent optimization needed`
          : warning.length > 0
            ? `${warning.length} endpoints with P95 500-1000ms — review and optimize`
            : 'Endpoint latency healthy',
    })
  })
)

/**
 * GET /api/ops/tracing/database-ops — Slowest database operations.
 * Shows which queries are bottlenecks.
 */
tracingRouter.get(
  '/database-ops',
  asyncHandler(async (_req, res) => {
    const ops = getSlowestDatabaseOps(20)

    const unindexed = ops.filter((op) => op.p95Ms > 500 && op.cacheHitRate < 0.3)
    const inefficient = ops.filter((op) => op.cacheHitRate < 0.1 && op.cacheHitRate >= 0)
    const healthy = ops.filter((op) => op.cacheHitRate > 0.5)

    res.json({
      slowestOperations: ops,
      insights: {
        unindexed: unindexed.map((op) => ({
          model: op.model,
          operation: op.operation,
          p95Ms: op.p95Ms,
          recommendation: 'Consider adding index',
        })),
        ineffectiveCache: inefficient.map((op) => ({
          model: op.model,
          operation: op.operation,
          hitRate: op.cacheHitRate,
          recommendation: 'Enable query result caching',
        })),
        wellCached: healthy.length,
      },
      recommendation:
        unindexed.length > 0
          ? `${unindexed.length} queries likely need indexes`
          : inefficient.length > 0
            ? `${inefficient.length} queries not using cache effectively`
            : 'Database operations healthy',
    })
  })
)

/**
 * GET /api/ops/tracing/external-services — External service call patterns.
 * Shows API calls to Stripe, OpenAI, Redis, etc.
 */
tracingRouter.get(
  '/external-services',
  asyncHandler(async (_req, res) => {
    const services = getExternalServiceStats(20)

    const slow = services.filter((s) => s.p95Ms > 2000)
    const unreliable = services.filter((s) => s.errorRate > 0.05)
    const healthy = services.filter((s) => s.errorRate === 0 && s.p95Ms <= 500)

    res.json({
      allServices: services,
      insights: {
        slowServices: slow.map((s) => ({
          service: s.service,
          p95Ms: s.p95Ms,
          recommendation: 'Consider implementing caching or async processing',
        })),
        unreliableServices: unreliable.map((s) => ({
          service: s.service,
          errorRate: (s.errorRate * 100).toFixed(1),
          recommendation: 'Implement circuit breaker or retry policy',
        })),
        healthy: healthy.length,
      },
      recommendation:
        slow.length > 0 || unreliable.length > 0
          ? `${slow.length} slow, ${unreliable.length} unreliable services — implement mitigations`
          : 'External services healthy',
    })
  })
)

/**
 * GET /api/ops/tracing/bottlenecks — Identified performance bottlenecks.
 * Ranked by impact (duration × frequency).
 */
tracingRouter.get(
  '/bottlenecks',
  asyncHandler(async (_req, res) => {
    const bottlenecks = identifyBottlenecks(15)

    const actionItems = bottlenecks.map((b) => ({
      spanType: b.spanName,
      averageDurationMs: b.avgDurationMs,
      impactScore: b.impactScore.toFixed(0),
      recommendation: b.recommendation,
    }))

    res.json({
      bottlenecks: actionItems,
      summary: {
        totalBottlenecks: bottlenecks.length,
        topBottleneck: bottlenecks[0]?.spanName || 'none',
        estimatedOptimizationGain: bottlenecks[0]
          ? `${(bottlenecks[0].avgDurationMs * 0.5).toFixed(0)}ms per request if fixed`
          : '0ms',
      },
      nextSteps:
        bottlenecks.length > 0
          ? [
              'Review top 3 bottlenecks',
              'Implement recommendations (indexes, caching, circuit breakers)',
              'Re-run tracing to measure improvement',
            ]
          : ['No major bottlenecks detected'],
    })
  })
)

/**
 * GET /api/ops/tracing/dependencies — Service dependency graph.
 * Shows how services call each other (API → DB, API → Cache, etc.).
 */
tracingRouter.get(
  '/dependencies',
  asyncHandler(async (_req, res) => {
    const dependencies = getServiceDependencies()

    // Identify potential issues: circular dependencies, long chains
    const chains = dependencies.filter((d) => d.downstreamServices.length > 3)

    res.json({
      serviceGraph: dependencies,
      insights: {
        totalServices: dependencies.length,
        totalConnections: dependencies.reduce((sum, d) => sum + d.downstreamServices.length, 0),
        potentiallyComplexChains: chains.map((c) => ({
          service: c.service,
          downstreamCount: c.downstreamServices.length,
          recommendation: 'Consider consolidating or optimizing call chain',
        })),
      },
    })
  })
)

/**
 * GET /api/ops/tracing/health — Overall distributed tracing health.
 */
tracingRouter.get(
  '/health',
  asyncHandler(async (_req, res) => {
    const summary = getAnalyticsSummary()
    const bottlenecks = identifyBottlenecks(5)
    const slowPaths = getSlowestPaths(5)

    const healthScore = Math.max(
      0,
      100 -
        summary.errorRate * 1000 -
        (summary.averageRequestDurationMs > 500 ? 30 : 0) -
        bottlenecks.length * 10
    )

    const status =
      healthScore >= 80
        ? 'healthy'
        : healthScore >= 60
          ? 'degraded'
          : 'critical'

    res.json({
      healthScore: Math.round(healthScore),
      status,
      summary,
      topIssues: [
        ...(slowPaths.length > 0 ? [`${slowPaths[0].path} P95: ${slowPaths[0].p95Ms}ms`] : []),
        ...(bottlenecks.length > 0 ? [`Bottleneck: ${bottlenecks[0].spanName}`] : []),
        ...(summary.errorRate > 0.01 ? [`Error rate: ${(summary.errorRate * 100).toFixed(1)}%`] : []),
      ],
      actionItems:
        status === 'critical'
          ? ['Review bottlenecks endpoint', 'Check error logs', 'Consider scaling']
          : status === 'degraded'
            ? ['Monitor slowest paths', 'Review database operations', 'Check external services']
            : ['No immediate action needed'],
    })
  })
)

/**
 * GET /api/ops/tracing/request-path/:path — Detailed analysis of a specific request path.
 */
tracingRouter.get(
  '/request-path/:path',
  asyncHandler(async (req, res) => {
    const path = `/${req.params.path.replace(/\+/g, '/')}`
    const paths = getSlowestPaths(100)
    const pathData = paths.find((p) => p.path === path)

    if (!pathData) {
      return res.status(404).json({ error: `No tracing data for path: ${path}` })
    }

    res.json({
      path,
      latency: pathData,
      recommendation:
        pathData.p95Ms > 1000
          ? 'Critical: P95 latency > 1s — urgent optimization needed'
          : pathData.p95Ms > 500
            ? 'Warning: P95 latency 500-1000ms — review and optimize'
            : 'Acceptable latency',
      nextSteps: [
        'Review bottlenecks endpoint for this request',
        'Check database operations called by this path',
        'Review external service calls',
      ],
    })
  })
)
