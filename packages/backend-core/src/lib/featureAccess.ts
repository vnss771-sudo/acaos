// Phase 4.9: Feature access control with plan tier matrix and dynamic degradation.
// Enables/disables features based on plan tier, budget remaining, and usage patterns.

import { logger } from './logger.js'

export type PlanTier = 'free' | 'starter' | 'growth'
export type FeatureStatus = 'available' | 'degraded' | 'disabled'

export interface Feature {
  id: string
  name: string
  description: string
  costPerRequest: number // $ per call
  costPerMonth: number // subscription cost
  rateLimit?: number // calls/min, null = unlimited
  degradationOrder: number // 1-10, lower = disable first when budget low
  minPlanTier: PlanTier
  createdAt: Date
}

export interface FeatureAccess {
  workspaceId: string
  featureId: string
  enabled: boolean
  reason?: string // why it's enabled/disabled
  disabledAt?: Date
  disabledReason?: string
}

export interface PlanTierMatrix {
  tier: PlanTier
  monthlyPrice: number
  features: string[] // feature IDs
  rateLimit: number // requests/min
  storageGB: number
  supportLevel: 'email' | 'priority' | 'dedicated'
}

export interface FeatureStatus {
  featureId: string
  status: FeatureStatus
  available: boolean
  reason: string
  costPerRequest: number
  rateLimitPerMin: number | null
}

// Storage
const features = new Map<string, Feature>()
const featureAccess = new Map<string, FeatureAccess[]>()
const planMatrices = new Map<PlanTier, PlanTierMatrix>()

/**
 * Register a feature.
 */
export function registerFeature(
  featureId: string,
  name: string,
  description: string,
  costPerRequest: number,
  costPerMonth: number,
  degradationOrder: number,
  minPlanTier: PlanTier = 'free',
  rateLimit?: number
): Feature {
  const feature: Feature = {
    id: featureId,
    name,
    description,
    costPerRequest,
    costPerMonth,
    rateLimit,
    degradationOrder,
    minPlanTier,
    createdAt: new Date(),
  }

  features.set(featureId, feature)

  logger.info('feature registered', {
    featureId,
    name,
    costPerRequest,
    degradationOrder,
  })

  return feature
}

/**
 * Get feature details.
 */
export function getFeature(featureId: string): Feature | null {
  return features.get(featureId) || null
}

/**
 * Set plan tier matrix (what features each tier gets).
 */
export function setPlanTierMatrix(matrix: PlanTierMatrix): PlanTierMatrix {
  planMatrices.set(matrix.tier, matrix)

  logger.info('plan tier matrix set', {
    tier: matrix.tier,
    features: matrix.features.length,
    price: matrix.monthlyPrice,
  })

  return matrix
}

/**
 * Get plan tier matrix.
 */
export function getPlanTierMatrix(tier: PlanTier): PlanTierMatrix {
  return planMatrices.get(tier) || getDefaultPlanMatrix(tier)
}

/**
 * Check if feature is available for workspace.
 */
export function isFeatureAvailable(workspaceId: string, featureId: string): boolean {
  const access = featureAccess.get(workspaceId) || []
  const feature = access.find((a) => a.featureId === featureId)
  return feature ? feature.enabled : false
}

/**
 * Enable feature for workspace.
 */
export function enableFeature(workspaceId: string, featureId: string): boolean {
  const list = featureAccess.get(workspaceId) || []
  const existing = list.findIndex((a) => a.featureId === featureId)

  const access: FeatureAccess = {
    workspaceId,
    featureId,
    enabled: true,
  }

  if (existing >= 0) {
    list[existing] = access
  } else {
    list.push(access)
  }

  featureAccess.set(workspaceId, list)
  return true
}

/**
 * Disable feature for workspace.
 */
export function disableFeature(
  workspaceId: string,
  featureId: string,
  reason: string = 'Admin disabled'
): boolean {
  const list = featureAccess.get(workspaceId) || []
  const existing = list.findIndex((a) => a.featureId === featureId)

  const access: FeatureAccess = {
    workspaceId,
    featureId,
    enabled: false,
    disabledAt: new Date(),
    disabledReason: reason,
  }

  if (existing >= 0) {
    list[existing] = access
  } else {
    list.push(access)
  }

  featureAccess.set(workspaceId, list)

  logger.info('feature disabled', {
    workspaceId,
    featureId,
    reason,
  })

  return true
}

/**
 * Get all features and their access status for workspace.
 */
export function getFeatureAccessList(workspaceId: string): FeatureStatus[] {
  const access = featureAccess.get(workspaceId) || []

  return Array.from(features.values()).map((feature) => {
    const a = access.find((x) => x.featureId === feature.id)
    const enabled = a ? a.enabled : false

    let status: FeatureStatus = enabled ? 'available' : 'disabled'
    let reason = enabled ? 'Feature enabled' : a?.disabledReason || 'Feature disabled'

    return {
      featureId: feature.id,
      status,
      available: enabled,
      reason,
      costPerRequest: feature.costPerRequest,
      rateLimitPerMin: feature.rateLimit || null,
    }
  })
}

/**
 * Apply feature degradation based on budget remaining.
 */
export function applyFeatureDegradation(
  workspaceId: string,
  budgetRemaining: number,
  budgetTotal: number
): { changed: number; disabled: string[] } {
  const percentageRemaining = (budgetRemaining / budgetTotal) * 100

  const disabled: string[] = []
  let changed = 0

  // Degradation thresholds
  const degradationRules = [
    { threshold: 75, maxDegradation: 10 }, // >75% budget: no degradation
    { threshold: 50, maxDegradation: 7 }, // 50-75%: disable non-critical
    { threshold: 25, maxDegradation: 5 }, // 25-50%: disable optional
    { threshold: 10, maxDegradation: 3 }, // 10-25%: keep only important
    { threshold: 0, maxDegradation: 1 }, // <10%: keep only critical
  ]

  const rule = degradationRules.find((r) => percentageRemaining < r.threshold)
  const maxDegradation = rule?.maxDegradation || 10

  const sortedFeatures = Array.from(features.values())
    .filter((f) => f.degradationOrder > maxDegradation)
    .sort((a, b) => a.degradationOrder - b.degradationOrder)

  for (const feature of sortedFeatures) {
    if (isFeatureAvailable(workspaceId, feature.id)) {
      disableFeature(
        workspaceId,
        feature.id,
        `Budget degradation: ${percentageRemaining.toFixed(0)}% remaining`
      )
      disabled.push(feature.id)
      changed++
    }
  }

  if (changed > 0) {
    logger.info('feature degradation applied', {
      workspaceId,
      budgetRemaining: `${percentageRemaining.toFixed(1)}%`,
      featuresDisabled: changed,
    })
  }

  return { changed, disabled }
}

/**
 * Restore features when budget recovered.
 */
export function restoreFeaturesForBudget(workspaceId: string, budgetRemaining: number, budgetTotal: number): {
  changed: number
  enabled: string[]
} {
  const percentageRemaining = (budgetRemaining / budgetTotal) * 100

  const enabled: string[] = []
  let changed = 0

  // Restoration thresholds (less aggressive than degradation)
  const restorationRules = [
    { threshold: 80, maxDegradation: 10 }, // >80% budget: restore all
    { threshold: 60, maxDegradation: 7 }, // 60-80%: restore optional
    { threshold: 30, maxDegradation: 5 }, // 30-60%: keep degraded
    { threshold: 15, maxDegradation: 3 }, // <30%: minimal restoration
  ]

  const rule = restorationRules.find((r) => percentageRemaining >= r.threshold)
  const maxDegradation = rule?.maxDegradation || 1

  const sortedFeatures = Array.from(features.values())
    .filter((f) => f.degradationOrder <= maxDegradation)
    .sort((a, b) => b.degradationOrder - a.degradationOrder)

  for (const feature of sortedFeatures) {
    if (!isFeatureAvailable(workspaceId, feature.id)) {
      enableFeature(workspaceId, feature.id)
      enabled.push(feature.id)
      changed++
    }
  }

  if (changed > 0) {
    logger.info('features restored', {
      workspaceId,
      budgetRemaining: `${percentageRemaining.toFixed(1)}%`,
      featuresEnabled: changed,
    })
  }

  return { changed, enabled }
}

/**
 * Get features for plan tier.
 */
export function getFeaturesForPlanTier(tier: PlanTier): Feature[] {
  const matrix = getPlanTierMatrix(tier)
  return matrix.features
    .map((id) => features.get(id))
    .filter((f): f is Feature => f !== null && f !== undefined)
}

/**
 * Check if feature is included in plan tier.
 */
export function isFeatureInTier(featureId: string, tier: PlanTier): boolean {
  const matrix = getPlanTierMatrix(tier)
  return matrix.features.includes(featureId)
}

/**
 * Get feature cost breakdown for workspace.
 */
export function getFeatureCostBreakdown(
  workspaceId: string,
  usage: Map<string, number>
): Array<{
  featureId: string
  name: string
  requestCount: number
  costPerRequest: number
  totalCost: number
}> {
  const breakdown: Array<{
    featureId: string
    name: string
    requestCount: number
    costPerRequest: number
    totalCost: number
  }> = []

  for (const [featureId, requestCount] of usage) {
    const feature = features.get(featureId)
    if (feature) {
      breakdown.push({
        featureId,
        name: feature.name,
        requestCount,
        costPerRequest: feature.costPerRequest,
        totalCost: requestCount * feature.costPerRequest,
      })
    }
  }

  return breakdown.sort((a, b) => b.totalCost - a.totalCost)
}

/**
 * Get total monthly cost for features used.
 */
export function getFeatureMonthlySubscriptionCost(featureIds: string[]): number {
  return featureIds.reduce((total, id) => {
    const feature = features.get(id)
    return total + (feature?.costPerMonth || 0)
  }, 0)
}

/**
 * Initialize default features.
 */
export function initializeDefaultFeatures(): void {
  // Core features
  registerFeature('basic_api', 'Basic API Access', 'Standard API endpoints', 0.0001, 0, 1, 'free')
  registerFeature('email_notifications', 'Email Notifications', 'Send email alerts', 0.001, 0, 2, 'free')
  registerFeature('slack_integration', 'Slack Integration', 'Post to Slack channels', 0.002, 10, 3, 'starter')
  registerFeature('advanced_analytics', 'Advanced Analytics', 'Detailed usage analytics', 0.05, 50, 4, 'starter')
  registerFeature('realtime_sync', 'Real-time Sync', 'Live data synchronization', 0.001, 25, 6, 'starter')
  registerFeature('ml_training', 'ML Model Training', 'AI/ML training jobs', 1.0, 200, 9, 'growth')
  registerFeature('custom_webhooks', 'Custom Webhooks', 'Custom webhook integrations', 0.01, 75, 7, 'growth')
  registerFeature('data_export', 'Data Export', 'Export workspace data', 0.005, 30, 5, 'starter')
  registerFeature('audit_logs', 'Audit Logging', 'Complete audit trail', 0.01, 99, 8, 'growth')

  // Plan matrices
  setPlanTierMatrix({
    tier: 'free',
    monthlyPrice: 0,
    features: ['basic_api', 'email_notifications'],
    rateLimit: 100,
    storageGB: 1,
    supportLevel: 'email',
  })

  setPlanTierMatrix({
    tier: 'starter',
    monthlyPrice: 99,
    features: [
      'basic_api',
      'email_notifications',
      'slack_integration',
      'advanced_analytics',
      'realtime_sync',
      'data_export',
    ],
    rateLimit: 1000,
    storageGB: 100,
    supportLevel: 'priority',
  })

  setPlanTierMatrix({
    tier: 'growth',
    monthlyPrice: 499,
    features: [
      'basic_api',
      'email_notifications',
      'slack_integration',
      'advanced_analytics',
      'realtime_sync',
      'data_export',
      'ml_training',
      'custom_webhooks',
      'audit_logs',
    ],
    rateLimit: 10000,
    storageGB: 10000,
    supportLevel: 'dedicated',
  })

  logger.info('default features initialized')
}

/**
 * Clear feature data (for testing).
 */
export function clearFeatures(): void {
  features.clear()
  featureAccess.clear()
  planMatrices.clear()
}

// Helpers

function getDefaultPlanMatrix(tier: PlanTier): PlanTierMatrix {
  const matrices: Record<PlanTier, PlanTierMatrix> = {
    free: {
      tier: 'free',
      monthlyPrice: 0,
      features: ['basic_api', 'email_notifications'],
      rateLimit: 100,
      storageGB: 1,
      supportLevel: 'email',
    },
    starter: {
      tier: 'starter',
      monthlyPrice: 99,
      features: ['basic_api', 'email_notifications', 'slack_integration', 'advanced_analytics'],
      rateLimit: 1000,
      storageGB: 100,
      supportLevel: 'priority',
    },
    growth: {
      tier: 'growth',
      monthlyPrice: 499,
      features: [
        'basic_api',
        'email_notifications',
        'slack_integration',
        'advanced_analytics',
        'ml_training',
      ],
      rateLimit: 10000,
      storageGB: 10000,
      supportLevel: 'dedicated',
    },
  }

  return matrices[tier]
}
