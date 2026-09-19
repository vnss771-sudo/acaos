// Plan-tier aware rate limiting. Phase 4.1 ensures rate limits scale with customer
// tier, preventing free-tier abuse while giving premium customers room to grow.
//
// Rate limit multipliers by plan:
// - free: 1x (baseline limits)
// - starter: 2x (paying customers deserve more throughput)
// - growth: 5x (enterprise tier)
//
// Operators can override per-plan via WORKSPACE_MAIL_RATE_MAX_FREE, etc.
// A workspace's actual limit = tier_multiplier * base_limit

import { prisma } from '@acaos/backend-core/lib/prisma.js'
import type { BillingPlan } from '@acaos/shared'

export type RateLimitTier = Record<BillingPlan, number>

// Base rate limits that are multiplied by plan tier
export const BASE_LIMITS = {
  mail: 100, // emails per minute
  ai: 500, // calls per hour
} as const

// Multipliers per plan tier (free: 1x, starter: 2x, growth: 5x)
export const PLAN_MULTIPLIERS: RateLimitTier = {
  free: 1,
  starter: 2,
  growth: 5,
}

/**
 * Get the effective rate limit for a workspace based on its plan tier.
 * Allows per-plan env var overrides for fine-tuning without code changes.
 *
 * Examples:
 * - free tier mail: 100/min (1x base)
 * - starter tier mail: 200/min (2x base)
 * - growth tier mail: 500/min (5x base)
 *
 * Set WORKSPACE_MAIL_RATE_MAX_FREE=50 to limit free tier to 50/min.
 */
export async function getEffectiveRateLimit(
  workspaceId: string,
  limitType: 'mail' | 'ai',
): Promise<number> {
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { plan: true },
  })

  const plan = (ws?.plan || 'free') as BillingPlan
  const baseLimit = BASE_LIMITS[limitType]
  const multiplier = PLAN_MULTIPLIERS[plan]

  // Check for env var override (WORKSPACE_MAIL_RATE_MAX_FREE, etc.)
  const envVarName = `WORKSPACE_${limitType.toUpperCase()}_RATE_MAX_${plan.toUpperCase()}`
  const envOverride = Number(process.env[envVarName])
  if (Number.isFinite(envOverride) && envOverride >= 0) {
    return envOverride
  }

  return baseLimit * multiplier
}

/**
 * Get all rate limits for a workspace (mail + ai) in one call.
 */
export async function getWorkspaceRateLimits(
  workspaceId: string,
): Promise<{ mail: number; ai: number }> {
  const [mail, ai] = await Promise.all([
    getEffectiveRateLimit(workspaceId, 'mail'),
    getEffectiveRateLimit(workspaceId, 'ai'),
  ])
  return { mail, ai }
}

/**
 * Describe rate limits for a workspace (for API responses, help text, etc.).
 * Returns human-readable description of the plan tier and effective limits.
 */
export async function describeWorkspaceRateLimits(workspaceId: string): Promise<string> {
  const limits = await getWorkspaceRateLimits(workspaceId)
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { plan: true },
  })

  const planName = ws?.plan || 'free'
  return `${planName} plan: ${limits.mail} emails/min, ${limits.ai} AI calls/hour`
}

/**
 * Get rate limit recommendations for upgrading from current tier.
 */
export function getUpgradeRecommendation(currentPlan: BillingPlan): {
  nextPlan: BillingPlan
  mailIncrease: number
  aiIncrease: number
} {
  if (currentPlan === 'growth') {
    return {
      nextPlan: 'growth',
      mailIncrease: 0,
      aiIncrease: 0,
    }
  }

  const nextPlan = currentPlan === 'free' ? 'starter' : 'growth'
  const currentMultiplier = PLAN_MULTIPLIERS[currentPlan]
  const nextMultiplier = PLAN_MULTIPLIERS[nextPlan]

  return {
    nextPlan,
    mailIncrease: BASE_LIMITS.mail * (nextMultiplier - currentMultiplier),
    aiIncrease: BASE_LIMITS.ai * (nextMultiplier - currentMultiplier),
  }
}
