// Phase 4.9: Dynamic rate limiting and feature access control endpoints.

import { Router } from 'express'
import { asyncHandler } from '../../lib/http.js'
import {
  createRateLimitBucket,
  getBucket,
  consumeTokens,
  getRateLimitStatus,
  queueRequest,
  getQueuedRequests,
  dequeueRequest,
  setTimeMultipliers,
  getTimeMultiplier,
  getEffectiveRefillRate,
  getEffectiveCostMultiplier,
  updateBucketRefillRate,
  getRateLimitMetrics,
  clearRateLimits,
  type Priority,
  type TimeMultiplier,
  type RateLimitBucket,
} from '@acaos/backend-core/lib/rateLimiting.js'
import {
  registerFeature,
  getFeature,
  setPlanTierMatrix,
  getPlanTierMatrix,
  isFeatureAvailable,
  enableFeature,
  disableFeature,
  getFeatureAccessList,
  applyFeatureDegradation,
  restoreFeaturesForBudget,
  getFeaturesForPlanTier,
  isFeatureInTier,
  getFeatureCostBreakdown,
  getFeatureMonthlySubscriptionCost,
  initializeDefaultFeatures,
  type PlanTier,
} from '@acaos/backend-core/lib/featureAccess.js'

export const phase49RateLimitRouter = Router()

// ============================================================================
// Rate Limit Bucket Management Endpoints
// ============================================================================

/**
 * POST /api/ops/ratelimit/:workspaceId/buckets — Create rate limit bucket.
 */
phase49RateLimitRouter.post(
  '/:workspaceId/buckets',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params
    const { teamId, endpoint, capacity, refillRate, priority = 'normal' } = req.body

    const bucket = createRateLimitBucket(
      workspaceId,
      capacity,
      refillRate,
      teamId,
      endpoint,
      priority as Priority
    )

    res.json({
      success: true,
      bucket: {
        id: bucket.id,
        workspaceId: bucket.workspaceId,
        teamId: bucket.teamId,
        endpoint: bucket.endpoint,
        capacity: bucket.capacity,
        refillRate: bucket.refillRate,
        priority: bucket.priority,
        createdAt: bucket.createdAt.toISOString(),
      },
      message: 'Rate limit bucket created',
    })
  })
)

/**
 * GET /api/ops/ratelimit/:workspaceId/buckets — Get bucket status.
 */
phase49RateLimitRouter.get(
  '/:workspaceId/buckets',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params
    const { teamId, endpoint } = req.query

    const bucket = getBucket(
      workspaceId,
      teamId as string | undefined,
      endpoint as string | undefined
    )

    if (!bucket) {
      return res.status(404).json({ error: 'Bucket not found' })
    }

    const status = getRateLimitStatus(
      workspaceId,
      teamId as string | undefined,
      endpoint as string | undefined
    )

    res.json({
      bucketId: bucket.id,
      tokens: Math.floor(bucket.tokens),
      capacity: bucket.capacity,
      refillRate: bucket.refillRate,
      priority: bucket.priority,
      percentageAvailable: `${status.percentageAvailable}%`,
      status: status.status,
      requestsInQueue: status.requestsInQueue,
      estimatedWaitMs: status.estimatedWaitMs,
    })
  })
)

/**
 * PUT /api/ops/ratelimit/:workspaceId/buckets/refill-rate — Update bucket refill rate.
 */
phase49RateLimitRouter.put(
  '/:workspaceId/buckets/refill-rate',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params
    const { teamId, endpoint, newRefillRate } = req.body

    const success = updateBucketRefillRate(
      workspaceId,
      newRefillRate,
      teamId,
      endpoint
    )

    if (!success) {
      return res.status(404).json({ error: 'Bucket not found' })
    }

    res.json({
      success: true,
      message: 'Refill rate updated',
    })
  })
)

// ============================================================================
// Token Consumption Endpoints
// ============================================================================

/**
 * POST /api/ops/ratelimit/:workspaceId/consume — Consume tokens.
 */
phase49RateLimitRouter.post(
  '/:workspaceId/consume',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params
    const { tokensRequired, teamId, endpoint } = req.body

    const allowed = consumeTokens(
      workspaceId,
      tokensRequired,
      teamId,
      endpoint
    )

    res.json({
      allowed,
      tokensRequired,
      message: allowed
        ? 'Tokens consumed successfully'
        : 'Insufficient tokens; request queued',
    })
  })
)

/**
 * GET /api/ops/ratelimit/:workspaceId/status — Get rate limit status.
 */
phase49RateLimitRouter.get(
  '/:workspaceId/status',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params
    const { teamId, endpoint } = req.query

    const status = getRateLimitStatus(
      workspaceId,
      teamId as string | undefined,
      endpoint as string | undefined
    )

    res.json({
      bucketId: status.bucketId,
      tokens: status.tokens,
      capacity: status.capacity,
      refillRate: status.refillRate,
      percentageAvailable: `${status.percentageAvailable}%`,
      status: status.status,
      requestsInQueue: status.requestsInQueue,
      estimatedWaitMs: status.estimatedWaitMs,
    })
  })
)

// ============================================================================
// Request Queue Management Endpoints
// ============================================================================

/**
 * POST /api/ops/ratelimit/:workspaceId/queue — Queue a request.
 */
phase49RateLimitRouter.post(
  '/:workspaceId/queue',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params
    const {
      requestId,
      endpoint,
      priority = 'normal',
      teamId,
      timeout = 300000,
    } = req.body

    const queued = queueRequest(
      requestId,
      workspaceId,
      endpoint,
      priority as Priority,
      teamId,
      timeout
    )

    res.json({
      success: true,
      queuedRequest: {
        id: queued.id,
        requestId: queued.requestId,
        priority: queued.priority,
        queuedAt: queued.queuedAt.toISOString(),
        estimatedWaitMs: queued.estimatedWaitMs,
        timeout,
      },
      message: 'Request queued for later execution',
    })
  })
)

/**
 * GET /api/ops/ratelimit/:workspaceId/queue — Get queued requests.
 */
phase49RateLimitRouter.get(
  '/:workspaceId/queue',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params
    const { teamId, endpoint, limit = '50' } = req.query

    const queued = getQueuedRequests(
      workspaceId,
      teamId as string | undefined,
      endpoint as string | undefined,
      parseInt(limit as string)
    )

    res.json({
      count: queued.length,
      requests: queued.map((q) => ({
        id: q.id,
        requestId: q.requestId,
        priority: q.priority,
        queuedAt: q.queuedAt.toISOString(),
        estimatedWaitMs: q.estimatedWaitMs,
        timeout: q.timeout,
      })),
    })
  })
)

/**
 * POST /api/ops/ratelimit/:workspaceId/dequeue — Dequeue a request.
 */
phase49RateLimitRouter.post(
  '/:workspaceId/dequeue',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params
    const { requestId, teamId, endpoint } = req.body

    const success = dequeueRequest(workspaceId, requestId, teamId, endpoint)

    if (!success) {
      return res.status(404).json({ error: 'Request not found in queue' })
    }

    res.json({
      success: true,
      message: 'Request dequeued',
    })
  })
)

// ============================================================================
// Time-of-Day Multiplier Endpoints
// ============================================================================

/**
 * POST /api/ops/ratelimit/:workspaceId/time-multipliers — Set time multipliers.
 */
phase49RateLimitRouter.post(
  '/:workspaceId/time-multipliers',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params
    const { multipliers } = req.body

    const result = setTimeMultipliers(workspaceId, multipliers as TimeMultiplier[])

    res.json({
      success: true,
      count: result.length,
      multipliers: result.map((m) => ({
        timeWindow: m.timeWindow,
        refillMultiplier: m.refillMultiplier,
        costMultiplier: m.costMultiplier,
      })),
      message: 'Time multipliers configured',
    })
  })
)

/**
 * GET /api/ops/ratelimit/:workspaceId/time-multiplier — Get current time multiplier.
 */
phase49RateLimitRouter.get(
  '/:workspaceId/time-multiplier',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params

    const multiplier = getTimeMultiplier(workspaceId)
    const effectiveRefillRate = getEffectiveRefillRate(workspaceId, 100)
    const effectiveCostMultiplier = getEffectiveCostMultiplier(workspaceId)

    res.json({
      timeWindow: multiplier.timeWindow,
      refillMultiplier: multiplier.refillMultiplier,
      costMultiplier: multiplier.costMultiplier,
      effectiveRefillRate: `${effectiveRefillRate} tokens/sec`,
      effectiveCostMultiplier,
    })
  })
)

// ============================================================================
// Feature Access Control Endpoints
// ============================================================================

/**
 * GET /api/ops/ratelimit/:workspaceId/features — Get all features and access status.
 */
phase49RateLimitRouter.get(
  '/:workspaceId/features',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params

    const features = getFeatureAccessList(workspaceId)

    res.json({
      workspaceId,
      count: features.length,
      features: features.map((f) => ({
        featureId: f.featureId,
        status: f.status,
        available: f.available,
        reason: f.reason,
        costPerRequest: f.costPerRequest,
        rateLimitPerMin: f.rateLimitPerMin,
      })),
    })
  })
)

/**
 * POST /api/ops/ratelimit/:workspaceId/features/:featureId/enable — Enable feature.
 */
phase49RateLimitRouter.post(
  '/:workspaceId/features/:featureId/enable',
  asyncHandler(async (req, res) => {
    const { workspaceId, featureId } = req.params

    const success = enableFeature(workspaceId, featureId)

    if (!success) {
      return res.status(400).json({ error: 'Failed to enable feature' })
    }

    res.json({
      success: true,
      message: `Feature ${featureId} enabled`,
    })
  })
)

/**
 * POST /api/ops/ratelimit/:workspaceId/features/:featureId/disable — Disable feature.
 */
phase49RateLimitRouter.post(
  '/:workspaceId/features/:featureId/disable',
  asyncHandler(async (req, res) => {
    const { workspaceId, featureId } = req.params
    const { reason = 'Admin disabled' } = req.body

    const success = disableFeature(workspaceId, featureId, reason)

    if (!success) {
      return res.status(400).json({ error: 'Failed to disable feature' })
    }

    res.json({
      success: true,
      message: `Feature ${featureId} disabled`,
    })
  })
)

/**
 * GET /api/ops/ratelimit/:workspaceId/features/:featureId — Get feature details.
 */
phase49RateLimitRouter.get(
  '/:workspaceId/features/:featureId',
  asyncHandler(async (req, res) => {
    const { featureId } = req.params

    const feature = getFeature(featureId)

    if (!feature) {
      return res.status(404).json({ error: 'Feature not found' })
    }

    res.json({
      featureId: feature.id,
      name: feature.name,
      description: feature.description,
      costPerRequest: feature.costPerRequest,
      costPerMonth: feature.costPerMonth,
      degradationOrder: feature.degradationOrder,
      minPlanTier: feature.minPlanTier,
      rateLimit: feature.rateLimit || null,
      createdAt: feature.createdAt.toISOString(),
    })
  })
)

// ============================================================================
// Budget-Based Feature Degradation Endpoints
// ============================================================================

/**
 * POST /api/ops/ratelimit/:workspaceId/degrade-features — Apply feature degradation.
 */
phase49RateLimitRouter.post(
  '/:workspaceId/degrade-features',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params
    const { budgetRemaining, budgetTotal } = req.body

    const result = applyFeatureDegradation(
      workspaceId,
      budgetRemaining,
      budgetTotal
    )

    res.json({
      success: true,
      changed: result.changed,
      disabledFeatures: result.disabled,
      message: `${result.changed} feature(s) disabled due to budget constraints`,
    })
  })
)

/**
 * POST /api/ops/ratelimit/:workspaceId/restore-features — Restore features for budget recovery.
 */
phase49RateLimitRouter.post(
  '/:workspaceId/restore-features',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params
    const { budgetRemaining, budgetTotal } = req.body

    const result = restoreFeaturesForBudget(
      workspaceId,
      budgetRemaining,
      budgetTotal
    )

    res.json({
      success: true,
      changed: result.changed,
      enabledFeatures: result.enabled,
      message: `${result.changed} feature(s) restored due to budget recovery`,
    })
  })
)

// ============================================================================
// Plan Tier Configuration Endpoints
// ============================================================================

/**
 * GET /api/ops/ratelimit/:workspaceId/plan-tiers/:tier — Get plan tier matrix.
 */
phase49RateLimitRouter.get(
  '/:workspaceId/plan-tiers/:tier',
  asyncHandler(async (req, res) => {
    const { tier } = req.params

    const matrix = getPlanTierMatrix(tier as PlanTier)

    res.json({
      tier: matrix.tier,
      monthlyPrice: `$${matrix.monthlyPrice}`,
      featureCount: matrix.features.length,
      features: matrix.features,
      rateLimit: `${matrix.rateLimit} requests/min`,
      storageGB: `${matrix.storageGB}GB`,
      supportLevel: matrix.supportLevel,
    })
  })
)

/**
 * POST /api/ops/ratelimit/:workspaceId/plan-tiers — Set plan tier matrix.
 */
phase49RateLimitRouter.post(
  '/:workspaceId/plan-tiers',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params
    const { tier, monthlyPrice, features, rateLimit, storageGB, supportLevel } =
      req.body

    const matrix = setPlanTierMatrix({
      tier: tier as PlanTier,
      monthlyPrice,
      features,
      rateLimit,
      storageGB,
      supportLevel,
    })

    res.json({
      success: true,
      matrix: {
        tier: matrix.tier,
        monthlyPrice: `$${matrix.monthlyPrice}`,
        featureCount: matrix.features.length,
        rateLimit: `${matrix.rateLimit} requests/min`,
        storageGB: `${matrix.storageGB}GB`,
        supportLevel: matrix.supportLevel,
      },
      message: `Plan tier '${tier}' configured`,
    })
  })
)

/**
 * GET /api/ops/ratelimit/:workspaceId/plan-tiers/:tier/features — Get features for plan tier.
 */
phase49RateLimitRouter.get(
  '/:workspaceId/plan-tiers/:tier/features',
  asyncHandler(async (req, res) => {
    const { tier } = req.params

    const features = getFeaturesForPlanTier(tier as PlanTier)

    res.json({
      tier,
      count: features.length,
      features: features.map((f) => ({
        id: f.id,
        name: f.name,
        costPerRequest: f.costPerRequest,
        costPerMonth: f.costPerMonth,
        degradationOrder: f.degradationOrder,
      })),
    })
  })
)

/**
 * GET /api/ops/ratelimit/:workspaceId/features/check/:featureId/tier/:tier — Check if feature in tier.
 */
phase49RateLimitRouter.get(
  '/:workspaceId/features/check/:featureId/tier/:tier',
  asyncHandler(async (req, res) => {
    const { featureId, tier } = req.params

    const included = isFeatureInTier(featureId, tier as PlanTier)

    res.json({
      featureId,
      tier,
      included,
    })
  })
)

// ============================================================================
// Feature Cost Endpoints
// ============================================================================

/**
 * POST /api/ops/ratelimit/:workspaceId/feature-costs — Get feature cost breakdown.
 */
phase49RateLimitRouter.post(
  '/:workspaceId/feature-costs',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params
    const { usage } = req.body // Map of featureId -> requestCount

    const usageMap = new Map(Object.entries(usage))
    // @ts-ignore - type mismatch handled at runtime
    const breakdown = getFeatureCostBreakdown(workspaceId, usageMap)

    const totalCost = breakdown.reduce((sum, b) => sum + b.totalCost, 0)

    res.json({
      workspaceId,
      count: breakdown.length,
      breakdown: breakdown.map((b) => ({
        featureId: b.featureId,
        name: b.name,
        requestCount: b.requestCount,
        costPerRequest: b.costPerRequest,
        totalCost: `$${b.totalCost.toFixed(2)}`,
      })),
      totalCost: `$${totalCost.toFixed(2)}`,
    })
  })
)

/**
 * GET /api/ops/ratelimit/:workspaceId/subscription-cost — Get subscription cost.
 */
phase49RateLimitRouter.get(
  '/:workspaceId/subscription-cost',
  asyncHandler(async (req, res) => {
    const { featureIds } = req.query

    const features = Array.isArray(featureIds) ? featureIds : [featureIds]
    const monthlyCost = getFeatureMonthlySubscriptionCost(features as string[])

    res.json({
      count: features.length,
      features,
      monthlySubscriptionCost: `$${monthlyCost.toFixed(2)}`,
    })
  })
)

// ============================================================================
// Metrics Endpoints
// ============================================================================

/**
 * GET /api/ops/ratelimit/:workspaceId/metrics — Get rate limit metrics.
 */
phase49RateLimitRouter.get(
  '/:workspaceId/metrics',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params

    const metrics = getRateLimitMetrics(workspaceId)

    res.json({
      workspaceId,
      totalBuckets: metrics.totalBuckets,
      totalQueuedRequests: metrics.totalQueuedRequests,
      averageTokenPercentage: `${metrics.averageTokenPercentage.toFixed(1)}%`,
      criticalBuckets: metrics.criticalBuckets,
      health:
        metrics.averageTokenPercentage > 50
          ? 'healthy'
          : metrics.averageTokenPercentage > 25
            ? 'warning'
            : 'critical',
    })
  })
)

// ============================================================================
// Initialization Endpoints
// ============================================================================

/**
 * POST /api/ops/ratelimit/initialize — Initialize default features.
 */
phase49RateLimitRouter.post(
  '/initialize',
  asyncHandler(async (req, res) => {
    initializeDefaultFeatures()

    res.json({
      success: true,
      message: 'Default features and plan tiers initialized',
    })
  })
)

/**
 * POST /api/ops/ratelimit/clear — Clear all rate limit data (testing only).
 */
phase49RateLimitRouter.post(
  '/clear',
  asyncHandler(async (req, res) => {
    clearRateLimits()

    res.json({
      success: true,
      message: 'All rate limit data cleared',
    })
  })
)
