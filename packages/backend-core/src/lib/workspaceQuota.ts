// Phase 4.4: Workspace quota management with daily/monthly reset cycles.
// Tracks usage metrics (API calls, emails, queries, storage) against configured
// quotas with soft caps (warnings) and hard caps (blocking).
//
// Quota types:
// - Soft cap: Usage exceeds threshold; warnings issued but requests allowed
// - Hard cap: Usage at limit; requests blocked with 429 Too Many Requests
//
// Reset cycles:
// - Daily: Resets at UTC midnight (for per-day limits)
// - Monthly: Resets on day 1 of month (for monthly quotas)
// - Rolling: Resets every 30 days from first usage

import { logger } from './logger.js'

export type QuotaType = 'api_calls' | 'emails_sent' | 'database_queries' | 'storage_bytes' | 'ai_tokens'

export type ResetCycle = 'daily' | 'monthly' | 'rolling'

export interface QuotaLimit {
  type: QuotaType
  softCapValue: number // Warning threshold
  hardCapValue: number // Blocking threshold
  resetCycle: ResetCycle
  plan: 'free' | 'starter' | 'growth'
}

export interface QuotaUsage {
  workspaceId: string
  quotaType: QuotaType
  currentUsage: number
  limitValue: number
  softCapValue: number
  resetAt: Date
  resetCycle: ResetCycle
  percentageUsed: number
  status: 'ok' | 'warning' | 'exceeded'
}

export interface QuotaCheck {
  allowed: boolean
  usage: QuotaUsage
  reason?: string
}

// Default quotas by plan and type
const DEFAULT_QUOTAS: Record<string, Record<QuotaType, { soft: number; hard: number }>> = {
  free: {
    api_calls: { soft: 4500, hard: 5000 }, // 500/hour average
    emails_sent: { soft: 8640, hard: 10000 }, // 100/min average
    database_queries: { soft: 450000, hard: 500000 }, // 5000 queries/min average
    storage_bytes: { soft: 536870912, hard: 1073741824 }, // 512MB soft, 1GB hard
    ai_tokens: { soft: 450000, hard: 500000 }, // OpenAI tokens/month
  },
  starter: {
    api_calls: { soft: 10800, hard: 12000 }, // 1000/hour average (2x free)
    emails_sent: { soft: 19440, hard: 22000 }, // 200/min average (2x free)
    database_queries: { soft: 900000, hard: 1000000 }, // 2x free
    storage_bytes: { soft: 2147483648, hard: 5368709120 }, // 2GB soft, 5GB hard
    ai_tokens: { soft: 900000, hard: 1000000 }, // 2x free
  },
  growth: {
    api_calls: { soft: 27000, hard: 30000 }, // 2500/hour average (5x free)
    emails_sent: { soft: 43200, hard: 50000 }, // 500/min average (5x free)
    database_queries: { soft: 2250000, hard: 2500000 }, // 5x free
    storage_bytes: { soft: 5368709120, hard: 10737418240 }, // 5GB soft, 10GB hard
    ai_tokens: { soft: 2250000, hard: 2500000 }, // 5x free
  },
}

const usageTracking = new Map<string, Map<QuotaType, { usage: number; resetAt: Date }>>()
const USAGE_PERSIST_INTERVAL = 30 * 1000 // Persist to DB every 30 seconds

/**
 * Get the next reset time for a quota based on its reset cycle.
 */
function getNextResetTime(cycle: ResetCycle, now: Date = new Date()): Date {
  const reset = new Date(now)

  if (cycle === 'daily') {
    // Next UTC midnight
    reset.setUTCHours(24, 0, 0, 0)
  } else if (cycle === 'monthly') {
    // First day of next month at UTC midnight
    reset.setUTCMonth(reset.getUTCMonth() + 1, 1)
    reset.setUTCHours(0, 0, 0, 0)
  } else if (cycle === 'rolling') {
    // 30 days from now
    reset.setDate(reset.getDate() + 30)
  }

  return reset
}

/**
 * Record usage against a workspace quota.
 * Returns whether the request should be allowed.
 */
export function checkQuota(workspaceId: string, quotaType: QuotaType, amount: number = 1): QuotaCheck {
  const quotaMap = usageTracking.get(workspaceId) || new Map()
  usageTracking.set(workspaceId, quotaMap)

  // Get current usage for this quota type
  let quotaData = quotaMap.get(quotaType)
  const now = new Date()

  // Check if quota needs reset
  if (!quotaData || (quotaData.resetAt && now >= quotaData.resetAt)) {
    const resetAt = getNextResetTime('daily', now) // Default to daily
    quotaData = { usage: 0, resetAt }
    quotaMap.set(quotaType, quotaData)
  }

  const newUsage = quotaData.usage + amount
  quotaData.usage = newUsage

  // Get quota limits for this workspace (would fetch from DB in production)
  const plan = 'starter' as const // This would come from workspace billing info
  const limits = DEFAULT_QUOTAS[plan][quotaType]

  // Determine status
  let status: 'ok' | 'warning' | 'exceeded'
  if (newUsage > limits.hard) {
    status = 'exceeded'
  } else if (newUsage > limits.soft) {
    status = 'warning'
  } else {
    status = 'ok'
  }

  const usage: QuotaUsage = {
    workspaceId,
    quotaType,
    currentUsage: newUsage,
    limitValue: limits.hard,
    softCapValue: limits.soft,
    resetAt: quotaData.resetAt,
    resetCycle: 'daily',
    percentageUsed: (newUsage / limits.hard) * 100,
    status,
  }

  const allowed = status !== 'exceeded'

  if (!allowed) {
    logger.warn('workspace quota exceeded', { workspaceId, quotaType, usage: newUsage, limit: limits.hard })
  } else if (status === 'warning') {
    logger.info('workspace quota warning', {
      workspaceId,
      quotaType,
      usage: newUsage,
      softCap: limits.soft,
      hardCap: limits.hard,
    })
  }

  return {
    allowed,
    usage,
    reason: !allowed ? `Quota exceeded: ${quotaType}` : status === 'warning' ? `Approaching quota limit` : undefined,
  }
}

/**
 * Get current usage for a workspace and quota type.
 */
export function getQuotaUsage(workspaceId: string, quotaType: QuotaType): QuotaUsage | null {
  const quotaMap = usageTracking.get(workspaceId)
  if (!quotaMap) return null

  const quotaData = quotaMap.get(quotaType)
  if (!quotaData) return null

  const plan = 'starter' as const
  const limits = DEFAULT_QUOTAS[plan][quotaType]

  return {
    workspaceId,
    quotaType,
    currentUsage: quotaData.usage,
    limitValue: limits.hard,
    softCapValue: limits.soft,
    resetAt: quotaData.resetAt,
    resetCycle: 'daily',
    percentageUsed: (quotaData.usage / limits.hard) * 100,
    status: quotaData.usage > limits.hard ? 'exceeded' : quotaData.usage > limits.soft ? 'warning' : 'ok',
  }
}

/**
 * Get all quotas for a workspace.
 */
export function getWorkspaceQuotas(workspaceId: string): QuotaUsage[] {
  const quotaMap = usageTracking.get(workspaceId)
  if (!quotaMap) return []

  const plan = 'starter' as const
  const quotas: QuotaUsage[] = []

  for (const quotaType of Object.keys(DEFAULT_QUOTAS[plan]) as QuotaType[]) {
    const quotaData = quotaMap.get(quotaType)
    if (quotaData) {
      const limits = DEFAULT_QUOTAS[plan][quotaType]
      quotas.push({
        workspaceId,
        quotaType,
        currentUsage: quotaData.usage,
        limitValue: limits.hard,
        softCapValue: limits.soft,
        resetAt: quotaData.resetAt,
        resetCycle: 'daily',
        percentageUsed: (quotaData.usage / limits.hard) * 100,
        status: quotaData.usage > limits.hard ? 'exceeded' : quotaData.usage > limits.soft ? 'warning' : 'ok',
      })
    }
  }

  return quotas
}

/**
 * Reset a quota immediately (for testing or manual adjustment).
 */
export function resetQuota(workspaceId: string, quotaType: QuotaType): void {
  const quotaMap = usageTracking.get(workspaceId)
  if (quotaMap) {
    const now = new Date()
    quotaMap.set(quotaType, { usage: 0, resetAt: getNextResetTime('daily', now) })
  }
}

/**
 * Get quota limits for a plan.
 */
export function getQuotaLimitsForPlan(plan: 'free' | 'starter' | 'growth'): Record<QuotaType, QuotaLimit> {
  const limits = DEFAULT_QUOTAS[plan]
  const result: Record<QuotaType, QuotaLimit> = {} as any

  for (const quotaType of Object.keys(limits) as QuotaType[]) {
    const limit = limits[quotaType]
    result[quotaType] = {
      type: quotaType,
      softCapValue: limit.soft,
      hardCapValue: limit.hard,
      resetCycle: 'daily',
      plan,
    }
  }

  return result
}

/**
 * Clear all quota tracking (for tests).
 */
export function clearAllQuotas(): void {
  usageTracking.clear()
}
