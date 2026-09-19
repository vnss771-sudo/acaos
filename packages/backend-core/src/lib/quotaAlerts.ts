// Phase 4.5: Real-time quota alerts and recommendations.
// Monitors quota usage and generates alerts when approaching limits,
// recommends plan upgrades, and predicts month-end overages.

import { logger } from './logger.js'

export type AlertLevel = 'info' | 'warning' | 'critical'
export type AlertType = 'quota_approaching' | 'quota_exceeded' | 'overage_forecast' | 'upgrade_recommended'

export interface QuotaAlert {
  workspaceId: string
  alertType: AlertType
  level: AlertLevel
  quotaType: string
  currentUsage: number
  limit: number
  softCap: number
  percentageUsed: number
  message: string
  recommendation?: string
  triggeredAt: Date
  resolvedAt?: Date
}

export interface AlertThresholds {
  softCapWarning: number // 75% of soft cap
  softCapCritical: number // 90% of soft cap
  hardCapWarning: number // 95% of hard cap
}

export interface UpgradeRecommendation {
  workspaceId: string
  currentPlan: 'free' | 'starter' | 'growth'
  recommendedPlan: 'starter' | 'growth' | 'enterprise'
  reason: string
  estimatedMonthlyCost: number
  savingsVsOverage: number
  urgency: 'low' | 'medium' | 'high'
}

export interface CostForecast {
  workspaceId: string
  currentMonthActual: number
  projectedMonthEnd: number
  projectedOverage: number
  daysRemaining: number
  recommendation: string
  shouldUpgrade: boolean
}

// Alert storage (in-memory; would be persisted to DB in production)
const activeAlerts = new Map<string, QuotaAlert[]>()
const alertHistory: QuotaAlert[] = []
const MAX_ALERT_HISTORY = 10000

export const ALERT_THRESHOLDS: AlertThresholds = {
  softCapWarning: 0.75, // 75% of soft cap triggers warning
  softCapCritical: 0.9, // 90% of soft cap triggers critical
  hardCapWarning: 0.95, // 95% of hard cap is critical
}

/**
 * Create a quota alert when usage approaches limits.
 */
export function createQuotaAlert(
  workspaceId: string,
  quotaType: string,
  currentUsage: number,
  softCap: number,
  hardCap: number
): QuotaAlert | null {
  const softCapPercentage = currentUsage / softCap
  const hardCapPercentage = currentUsage / hardCap

  let alertType: AlertType | null = null
  let level: AlertLevel = 'info'
  let message = ''
  let recommendation = ''

  // Determine alert level and type
  if (currentUsage > hardCap) {
    alertType = 'quota_exceeded'
    level = 'critical'
    message = `Hard cap exceeded for ${quotaType}`
    recommendation = `Upgrade plan or contact support for immediate relief`
  } else if (hardCapPercentage >= ALERT_THRESHOLDS.hardCapWarning) {
    alertType = 'quota_approaching'
    level = 'critical'
    message = `Critical: ${quotaType} at ${(hardCapPercentage * 100).toFixed(0)}% of hard cap`
    recommendation = `Upgrade plan immediately to avoid request blocking`
  } else if (softCapPercentage >= ALERT_THRESHOLDS.softCapCritical) {
    alertType = 'quota_approaching'
    level = 'warning'
    message = `Warning: ${quotaType} at ${(softCapPercentage * 100).toFixed(0)}% of soft cap`
    recommendation = `Consider upgrading plan to next tier`
  } else if (softCapPercentage >= ALERT_THRESHOLDS.softCapWarning) {
    alertType = 'quota_approaching'
    level = 'warning'
    message = `Approaching soft cap for ${quotaType}`
    recommendation = `Monitor usage; upgrade soon if trend continues`
  }

  if (!alertType) {
    return null // No alert needed
  }

  const alert: QuotaAlert = {
    workspaceId,
    alertType,
    level,
    quotaType,
    currentUsage,
    limit: hardCap,
    softCap,
    percentageUsed: (currentUsage / hardCap) * 100,
    message,
    recommendation,
    triggeredAt: new Date(),
  }

  // Store alert
  const wsAlerts = activeAlerts.get(workspaceId) || []
  wsAlerts.push(alert)
  activeAlerts.set(workspaceId, wsAlerts)
  alertHistory.push(alert)

  // Trim history if too large
  if (alertHistory.length > MAX_ALERT_HISTORY) {
    alertHistory.splice(0, MAX_ALERT_HISTORY - 5000)
  }

  logger.warn('quota alert created', {
    workspaceId,
    alertType,
    quotaType,
    percentageUsed: alert.percentageUsed.toFixed(0),
  })

  return alert
}

/**
 * Resolve an active alert (quota dropped below threshold).
 */
export function resolveQuotaAlert(workspaceId: string, quotaType: string): void {
  const wsAlerts = activeAlerts.get(workspaceId)
  if (!wsAlerts) return

  const alertIndex = wsAlerts.findIndex((a) => a.quotaType === quotaType && !a.resolvedAt)
  if (alertIndex >= 0) {
    wsAlerts[alertIndex].resolvedAt = new Date()
  }
}

/**
 * Get active alerts for a workspace.
 */
export function getActiveAlerts(workspaceId: string): QuotaAlert[] {
  const alerts = activeAlerts.get(workspaceId) || []
  return alerts.filter((a) => !a.resolvedAt)
}

/**
 * Get all alerts for a workspace (including resolved).
 */
export function getAlertHistory(workspaceId: string): QuotaAlert[] {
  return alertHistory.filter((a) => a.workspaceId === workspaceId)
}

/**
 * Recommend plan upgrade based on usage patterns.
 */
export function recommendPlanUpgrade(
  workspaceId: string,
  currentPlan: 'free' | 'starter' | 'growth',
  projectedOverage: number,
  currentMonthCost: number
): UpgradeRecommendation | null {
  // Plan pricing
  const pricing = {
    free: 0,
    starter: 29,
    growth: 99,
    enterprise: 500, // placeholder
  }

  // If free plan, always recommend upgrade
  if (currentPlan === 'free') {
    return {
      workspaceId,
      currentPlan,
      recommendedPlan: 'starter',
      reason: 'Free plan has limited quotas; Starter enables 2x resources',
      estimatedMonthlyCost: pricing.starter,
      savingsVsOverage: projectedOverage,
      urgency: 'high',
    }
  }

  // If overage would be high, recommend upgrade
  if (projectedOverage > pricing[currentPlan as keyof typeof pricing] * 0.5) {
    const nextPlan = currentPlan === 'starter' ? 'growth' : 'enterprise'
    const nextPlanCost = pricing[nextPlan as keyof typeof pricing]
    const savings = projectedOverage - (nextPlanCost - pricing[currentPlan])

    return {
      workspaceId,
      currentPlan,
      recommendedPlan: nextPlan,
      reason: `Projected overage (${projectedOverage.toFixed(2)}) exceeds upgrade cost`,
      estimatedMonthlyCost: nextPlanCost,
      savingsVsOverage: savings > 0 ? savings : 0,
      urgency: savings > 0 ? 'high' : 'medium',
    }
  }

  return null // No upgrade recommended
}

/**
 * Forecast month-end costs based on current usage trends.
 */
export function forecastMonthEnd(
  workspaceId: string,
  currentMonthUsage: number,
  daysElapsed: number,
  currentMonthCost: number,
  plan: 'free' | 'starter' | 'growth'
): CostForecast {
  const now = new Date()
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0)
  const daysInMonth = monthEnd.getDate()
  const daysRemaining = daysInMonth - daysElapsed

  // Project to month-end
  const dailyRate = currentMonthUsage / daysElapsed
  const projectedMonthEnd = Math.ceil(dailyRate * daysInMonth)

  // Estimate overage cost (base tier + overage)
  const baseCosts = { free: 0, starter: 29, growth: 99 }
  const projectedTotalCost = baseCosts[plan] + currentMonthCost

  // Cost forecast
  const forecast: CostForecast = {
    workspaceId,
    currentMonthActual: Math.round(currentMonthCost * 100) / 100,
    projectedMonthEnd,
    projectedOverage: Math.max(0, projectedMonthEnd - currentMonthUsage),
    daysRemaining,
    recommendation: '',
    shouldUpgrade: false,
  }

  // Generate recommendations
  if (projectedMonthEnd > currentMonthUsage * 1.5) {
    forecast.recommendation =
      'Usage trend accelerating. Consider slow-down or plan upgrade to avoid spike'
    forecast.shouldUpgrade = true
  } else if (daysRemaining <= 5 && projectedMonthEnd > currentMonthUsage * 1.2) {
    forecast.recommendation = 'Month-end approaching with elevated usage. Monitor closely'
  } else {
    forecast.recommendation = 'Usage trend is stable'
  }

  return forecast
}

/**
 * Get critical metrics summary (high-level alert dashboard).
 */
export function getAlertSummary(): {
  totalActiveAlerts: number
  criticalAlerts: number
  warningAlerts: number
  affectedWorkspaces: number
} {
  let totalAlerts = 0
  let criticalCount = 0
  let warningCount = 0

  for (const alerts of activeAlerts.values()) {
    const active = alerts.filter((a) => !a.resolvedAt)
    totalAlerts += active.length
    criticalCount += active.filter((a) => a.level === 'critical').length
    warningCount += active.filter((a) => a.level === 'warning').length
  }

  return {
    totalActiveAlerts: totalAlerts,
    criticalAlerts: criticalCount,
    warningAlerts: warningCount,
    affectedWorkspaces: activeAlerts.size,
  }
}

/**
 * Clear all alerts (for testing).
 */
export function clearAlerts(): void {
  activeAlerts.clear()
  alertHistory.length = 0
}
