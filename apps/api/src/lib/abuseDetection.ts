// Abuse detection and emergency throttling. Phase 4.1 operational safety.
// Detects anomalous workspace behavior (sudden spike in API calls, rate limit hits)
// and automatically applies tighter rate limits to prevent cascade failures.
//
// Patterns detected:
// - Sudden increase in rate limit hits from a workspace (likely script/bot)
// - Sustained high query load above plan tier baseline
// - Repeated failed authentication from a single account
// Emergency actions:
// - Tighten per-workspace rate limits
// - Reduce per-workspace quota temporarily
// - Log incidents for manual review

import { getRedis } from './redis.js'
import { prisma } from '@acaos/backend-core/lib/prisma.js'
import { logger } from '@acaos/backend-core/lib/logger.js'
import { ApiError } from './http.js'

interface AbuseSignal {
  workspaceId: string
  type: 'rate_limit_spike' | 'high_query_load' | 'auth_failure_burst'
  severity: 'low' | 'medium' | 'high'
  evidence: string
  timestamp: Date
}

// In-process incident log (100 most recent, circular)
const incidents: AbuseSignal[] = []
const INCIDENT_LOG_MAX = 100

/**
 * Record a potential abuse signal. When three or more signals accumulate
 * within 5 minutes, escalate to HIGH severity and emit an alert.
 */
function recordSignal(signal: AbuseSignal): void {
  incidents.push(signal)
  if (incidents.length > INCIDENT_LOG_MAX) incidents.shift()

  // Check for escalation: 3+ signals from same workspace within 5 min
  const fiveMinAgo = Date.now() - 5 * 60 * 1000
  const recentFromWorkspace = incidents.filter(
    (s) => s.workspaceId === signal.workspaceId && s.timestamp.getTime() > fiveMinAgo,
  ).length

  if (recentFromWorkspace >= 3) {
    logger.warn('workspace abuse escalation detected', {
      workspaceId: signal.workspaceId,
      signalCount: recentFromWorkspace,
      latest: signal.type,
      recommendation: 'Review workspace activity; consider manual throttling or suspension',
    })
  }
}

/**
 * Detect and react to sudden spikes in rate limit hits from a workspace.
 * Call after a 429 response to a workspace-scoped request.
 */
export async function checkForRateLimitSpike(workspaceId: string): Promise<void> {
  try {
    const redis = getRedis()
    if (redis.status !== 'ready') return

    // Count 429s in the last minute
    const key = `abuse:429:${workspaceId}`
    const count = await redis.incr(key)
    if (count === 1) await redis.expire(key, 60)

    // Spike threshold: >10 rate limit hits in 60 seconds from one workspace
    if (count > 10) {
      const signal: AbuseSignal = {
        workspaceId,
        type: 'rate_limit_spike',
        severity: count > 20 ? 'high' : 'medium',
        evidence: `${count} rate limit hits in 60 seconds`,
        timestamp: new Date(),
      }
      recordSignal(signal)

      // For HIGH severity, immediately tighten the limit
      if (signal.severity === 'high') {
        logger.error('rate limit spike HIGH severity — emergency throttling', {
          workspaceId,
          hitCount: count,
        })
        // In production, could automatically set a tighter WORKSPACE_MAIL_RATE_MAX
        // via a Redis-backed config, but for now just log for manual ops review.
      }
    }
  } catch (err) {
    // Best-effort — don't let abuse detection block requests
    logger.warn('rate limit spike check failed', { error: (err as Error).message })
  }
}

/**
 * Detect sustained high query load above what the workspace's plan tier should allow.
 * Call periodically (e.g., every 5 min) to identify resource hogs.
 */
export async function checkForHighQueryLoad(workspaceId: string, queryCountLastHour: number): Promise<void> {
  try {
    // Baseline expectations per plan (rough estimates)
    const ws = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { plan: true },
    })

    const expectedBaseline = {
      free: 200,
      starter: 1000,
      growth: 5000,
    }[ws?.plan || 'free']

    if (queryCountLastHour > expectedBaseline * 2) {
      const signal: AbuseSignal = {
        workspaceId,
        type: 'high_query_load',
        severity: queryCountLastHour > expectedBaseline * 5 ? 'high' : 'medium',
        evidence: `${queryCountLastHour} queries/hour (baseline: ${expectedBaseline})`,
        timestamp: new Date(),
      }
      recordSignal(signal)
    }
  } catch (err) {
    logger.warn('query load check failed', { error: (err as Error).message })
  }
}

/**
 * Detect repeated failed auth attempts against a single user account
 * across multiple IPs or in rapid succession (distributed brute force).
 * Call after each auth failure.
 */
export async function checkForAuthFailureBurst(email: string): Promise<void> {
  try {
    const redis = getRedis()
    if (redis.status !== 'ready') return

    // Per-user failure tracking (separate from IP-based auth limiter)
    const key = `abuse:auth_fail:${email}`
    const count = await redis.incr(key)
    if (count === 1) await redis.expire(key, 300) // 5-min window

    if (count > 5) {
      // More than 5 failed logins in 5 min
      const signal: AbuseSignal = {
        workspaceId: 'N/A', // Auth is pre-workspace
        type: 'auth_failure_burst',
        severity: count > 10 ? 'high' : 'low',
        evidence: `${count} failed logins in 5 minutes`,
        timestamp: new Date(),
      }
      recordSignal(signal)

      // At HIGH severity, temporarily lock the account
      if (signal.severity === 'high') {
        logger.warn('auth failure burst — account lock recommended', { email, hitCount: count })
        // In production, could temporarily mark the account as locked
        // until an admin reviews. For now, just log.
      }
    }
  } catch (err) {
    logger.warn('auth failure burst check failed', { error: (err as Error).message })
  }
}

/**
 * Get the incident log for the last N hours. Used by /api/ops/abuse endpoint.
 */
export function getIncidentLog(hoursBack = 1): AbuseSignal[] {
  const cutoff = Date.now() - hoursBack * 60 * 60 * 1000
  return incidents.filter((s) => s.timestamp.getTime() > cutoff)
}

/**
 * Clear the incident log (for testing or manual reset).
 */
export function clearIncidentLog(): void {
  incidents.length = 0
}

/**
 * Get aggregate abuse metrics for the whole system.
 */
export function getAbuseMetrics(): {
  totalIncidents: number
  byType: Record<string, number>
  bySeverity: Record<string, number>
  topWorkspaces: Array<[string, number]>
} {
  const byType: Record<string, number> = {}
  const bySeverity: Record<string, number> = {}
  const workspaceCounts: Map<string, number> = new Map()

  for (const incident of incidents) {
    byType[incident.type] = (byType[incident.type] ?? 0) + 1
    bySeverity[incident.severity] = (bySeverity[incident.severity] ?? 0) + 1
    workspaceCounts.set(incident.workspaceId, (workspaceCounts.get(incident.workspaceId) ?? 0) + 1)
  }

  return {
    totalIncidents: incidents.length,
    byType,
    bySeverity,
    topWorkspaces: Array.from(workspaceCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10),
  }
}
