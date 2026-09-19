// Phase 4.4: Usage attribution and cost tracking.
// Tracks actual resource consumption per workspace and calculates costs.
//
// Tracked metrics:
// - API calls (by endpoint)
// - Emails sent (count + recipients)
// - Database queries (by model, operation)
// - Storage used (database + file)
// - AI tokens consumed (OpenAI, etc.)
// - Queue jobs processed
//
// Cost calculation:
// - Base tier cost (from billing plan)
// - Overage costs (usage beyond included tier)
// - External API costs (OpenAI per token, Stripe per call, etc.)

import { logger } from './logger.js'

export interface UsageMetric {
  workspaceId: string
  metricType: 'api_call' | 'email_sent' | 'db_query' | 'storage_bytes' | 'ai_token' | 'job_processed'
  amount: number
  metadata: Record<string, unknown>
  recordedAt: Date
}

export interface CostBreakdown {
  workspaceId: string
  period: 'daily' | 'monthly'
  periodStart: Date
  periodEnd: Date
  costs: {
    baseTierCost: number
    overageCost: number
    externalApiCost: number
    totalCost: number
  }
  usage: {
    apiCalls: number
    emailsSent: number
    dbQueries: number
    storageBytes: number
    aiTokens: number
    jobsProcessed: number
  }
  breakdown: Array<{
    category: string
    usage: number
    limit: number
    cost: number
  }>
}

// Pricing constants (customizable per deployment)
export const PRICING = {
  baseCost: {
    free: 0,
    starter: 29,
    growth: 99,
  },
  overagePricing: {
    apiCalls: 0.001, // $0.001 per API call over limit
    emailsSent: 0.0005, // $0.0005 per email over limit
    dbQueries: 0.00001, // $0.00001 per query over limit
    aiTokens: 0.000002, // $0.000002 per token (roughly $0.002 per 1k tokens)
  },
  externalApi: {
    openaiPerToken: 0.000002,
    stripePerCall: 0.003,
    redisPerGb: 0.25,
  },
}

// In-memory usage log (would be persisted to DB in production)
const usageLog: UsageMetric[] = []
const MAX_LOG_ENTRIES = 100000

/**
 * Record a usage event.
 */
export function recordUsage(metric: Omit<UsageMetric, 'recordedAt'>): void {
  usageLog.push({
    ...metric,
    recordedAt: new Date(),
  })

  // Trim old entries if log gets too large
  if (usageLog.length > MAX_LOG_ENTRIES) {
    usageLog.splice(0, MAX_LOG_ENTRIES - 50000) // Keep newest 50k
  }
}

/**
 * Get usage summary for a workspace in a period.
 */
export function getUsageSummary(
  workspaceId: string,
  startDate: Date,
  endDate: Date
): {
  apiCalls: number
  emailsSent: number
  dbQueries: number
  storageBytes: number
  aiTokens: number
  jobsProcessed: number
} {
  const metrics = usageLog.filter(
    (m) => m.workspaceId === workspaceId && m.recordedAt >= startDate && m.recordedAt <= endDate
  )

  return {
    apiCalls: metrics.filter((m) => m.metricType === 'api_call').reduce((sum, m) => sum + m.amount, 0),
    emailsSent: metrics.filter((m) => m.metricType === 'email_sent').reduce((sum, m) => sum + m.amount, 0),
    dbQueries: metrics.filter((m) => m.metricType === 'db_query').reduce((sum, m) => sum + m.amount, 0),
    storageBytes: metrics.filter((m) => m.metricType === 'storage_bytes').reduce((sum, m) => sum + m.amount, 0),
    aiTokens: metrics.filter((m) => m.metricType === 'ai_token').reduce((sum, m) => sum + m.amount, 0),
    jobsProcessed: metrics.filter((m) => m.metricType === 'job_processed').reduce((sum, m) => sum + m.amount, 0),
  }
}

/**
 * Calculate cost for a workspace in a period.
 */
export function calculateCost(workspaceId: string, plan: 'free' | 'starter' | 'growth', monthStart: Date, monthEnd: Date): CostBreakdown {
  const usage = getUsageSummary(workspaceId, monthStart, monthEnd)

  // Determine included limits based on plan
  const limits = {
    free: { apiCalls: 5000, emailsSent: 10000, dbQueries: 500000, aiTokens: 500000 },
    starter: { apiCalls: 12000, emailsSent: 22000, dbQueries: 1000000, aiTokens: 1000000 },
    growth: { apiCalls: 30000, emailsSent: 50000, dbQueries: 2500000, aiTokens: 2500000 },
  }[plan]

  // Calculate overage
  const apiCallOverage = Math.max(0, usage.apiCalls - limits.apiCalls)
  const emailOverage = Math.max(0, usage.emailsSent - limits.emailsSent)
  const dbQueryOverage = Math.max(0, usage.dbQueries - limits.dbQueries)
  const aiTokenOverage = Math.max(0, usage.aiTokens - limits.aiTokens)

  // Calculate costs
  const baseTierCost = PRICING.baseCost[plan]
  const overageCost =
    apiCallOverage * PRICING.overagePricing.apiCalls +
    emailOverage * PRICING.overagePricing.emailsSent +
    dbQueryOverage * PRICING.overagePricing.dbQueries +
    aiTokenOverage * PRICING.overagePricing.aiTokens

  const externalApiCost = usage.aiTokens * PRICING.externalApi.openaiPerToken + (usage.storageBytes / (1024 * 1024 * 1024)) * PRICING.externalApi.redisPerGb

  const totalCost = baseTierCost + overageCost + externalApiCost

  const breakdown = [
    {
      category: 'API Calls',
      usage: usage.apiCalls,
      limit: limits.apiCalls,
      cost: apiCallOverage * PRICING.overagePricing.apiCalls,
    },
    {
      category: 'Emails Sent',
      usage: usage.emailsSent,
      limit: limits.emailsSent,
      cost: emailOverage * PRICING.overagePricing.emailsSent,
    },
    {
      category: 'Database Queries',
      usage: usage.dbQueries,
      limit: limits.dbQueries,
      cost: dbQueryOverage * PRICING.overagePricing.dbQueries,
    },
    {
      category: 'AI Tokens',
      usage: usage.aiTokens,
      limit: limits.aiTokens,
      cost: aiTokenOverage * PRICING.overagePricing.aiTokens,
    },
  ]

  return {
    workspaceId,
    period: 'monthly',
    periodStart: monthStart,
    periodEnd: monthEnd,
    costs: {
      baseTierCost,
      overageCost,
      externalApiCost,
      totalCost,
    },
    usage,
    breakdown,
  }
}

/**
 * Get top usage consumers (for billing/analytics).
 */
export function getTopWorkspacesByUsage(
  metricType: 'api_calls' | 'emails' | 'queries' | 'storage',
  limit: number = 20
): Array<{ workspaceId: string; usage: number }> {
  const map = new Map<string, number>()

  for (const metric of usageLog) {
    let key: string | null = null

    if (metricType === 'api_calls' && metric.metricType === 'api_call') key = metric.workspaceId
    else if (metricType === 'emails' && metric.metricType === 'email_sent') key = metric.workspaceId
    else if (metricType === 'queries' && metric.metricType === 'db_query') key = metric.workspaceId
    else if (metricType === 'storage' && metric.metricType === 'storage_bytes') key = metric.workspaceId

    if (key) {
      map.set(key, (map.get(key) || 0) + metric.amount)
    }
  }

  return Array.from(map.entries())
    .map(([workspaceId, usage]) => ({ workspaceId, usage }))
    .sort((a, b) => b.usage - a.usage)
    .slice(0, limit)
}

/**
 * Get usage trend for a workspace over time.
 */
export function getUsageTrend(
  workspaceId: string,
  metricType: 'api_calls' | 'emails' | 'queries' | 'storage',
  days: number = 30
): Array<{ date: string; usage: number }> {
  const trend = new Map<string, number>()

  const now = new Date()
  const startDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)

  for (const metric of usageLog) {
    if (metric.workspaceId !== workspaceId) continue

    let matches = false
    if (metricType === 'api_calls' && metric.metricType === 'api_call') matches = true
    else if (metricType === 'emails' && metric.metricType === 'email_sent') matches = true
    else if (metricType === 'queries' && metric.metricType === 'db_query') matches = true
    else if (metricType === 'storage' && metric.metricType === 'storage_bytes') matches = true

    if (matches && metric.recordedAt >= startDate) {
      const date = metric.recordedAt.toISOString().split('T')[0]
      trend.set(date, (trend.get(date) || 0) + metric.amount)
    }
  }

  return Array.from(trend.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, usage]) => ({ date, usage }))
}

/**
 * Clear usage log (for testing).
 */
export function clearUsageLog(): void {
  usageLog.length = 0
}
