import { prisma } from './prisma.js'

// Sender-reputation circuit breaker. Reads the ContactEvent ledger (the durable
// source of truth) to compute a workspace's trailing-window bounce and complaint
// rates, then decides whether the workspace's deliverability is healthy enough to
// keep sending. A degraded reputation only ever HALTS sends — it never causes an
// extra one — so the guard is fail-safe by construction.
//
// Conservative by design: the verdict stays "healthy" until a MINIMUM sample of
// sends has accumulated in the window, so a brand-new or low-volume workspace is
// never blocked by statistical noise (one bounce out of three sends is not a
// signal). Thresholds follow common ESP guidance: hard-bounce alarm ~5%, complaint
// alarm ~0.3%. Everything is env-overridable and read live (no caching).

export type ReputationBlockReason = 'BOUNCE_RATE_HIGH' | 'COMPLAINT_RATE_HIGH'

export interface ReputationThresholds {
  windowDays: number
  minSends: number
  maxBounceRate: number
  maxComplaintRate: number
}

export interface ReputationVerdict {
  healthy: boolean
  totalSends: number
  bounces: number
  complaints: number
  bounceRate: number // bounces / totalSends (0 when no sends)
  complaintRate: number // complaints / totalSends
  reason: ReputationBlockReason | null
  thresholds: ReputationThresholds
}

// Non-negative numeric env parse with a safe fallback.
function num(raw: string | undefined, dflt: number): number {
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : dflt
}

export function reputationThresholds(): ReputationThresholds {
  return {
    windowDays: num(process.env.REPUTATION_WINDOW_DAYS, 7),
    minSends: num(process.env.REPUTATION_MIN_SENDS, 50),
    maxBounceRate: num(process.env.REPUTATION_MAX_BOUNCE_RATE, 0.05),
    maxComplaintRate: num(process.env.REPUTATION_MAX_COMPLAINT_RATE, 0.003),
  }
}

/**
 * Pure verdict from raw counts + thresholds. Separated from the DB read so the
 * threshold/min-sample logic is unit-tested without a database. Below minSends the
 * verdict is always healthy (too little data to act on). Bounce rate is evaluated
 * before complaint rate, so a workspace breaching both reports BOUNCE_RATE_HIGH.
 * Comparisons are strict (`>`), so a rate exactly at the threshold is still healthy.
 */
export function verdictFor(
  counts: { totalSends: number; bounces: number; complaints: number },
  t: ReputationThresholds,
): ReputationVerdict {
  const { totalSends, bounces, complaints } = counts
  const bounceRate = totalSends > 0 ? bounces / totalSends : 0
  const complaintRate = totalSends > 0 ? complaints / totalSends : 0
  let reason: ReputationBlockReason | null = null
  if (totalSends >= t.minSends) {
    if (bounceRate > t.maxBounceRate) reason = 'BOUNCE_RATE_HIGH'
    else if (complaintRate > t.maxComplaintRate) reason = 'COMPLAINT_RATE_HIGH'
  }
  return { healthy: reason === null, totalSends, bounces, complaints, bounceRate, complaintRate, reason, thresholds: t }
}

/**
 * Evaluate a workspace's sender reputation over the trailing window from the
 * ledger. SENT and BOUNCED come from ContactEvent; complaints come from
 * UnsubscribeEvent(source=COMPLAINT) (there is no ContactEvent COMPLAINT type),
 * so the complaint rate is correct the moment a feedback-loop ingester starts
 * writing those. Read-only.
 */
export async function evaluateSenderReputation(
  workspaceId: string,
  now: Date = new Date(),
): Promise<ReputationVerdict> {
  const t = reputationThresholds()
  const since = new Date(now.getTime() - t.windowDays * 24 * 60 * 60 * 1000)

  const [totalSends, bounces, complaints] = await Promise.all([
    prisma.contactEvent.count({ where: { workspaceId, type: 'SENT', occurredAt: { gte: since } } }),
    prisma.contactEvent.count({ where: { workspaceId, type: 'BOUNCED', occurredAt: { gte: since } } }),
    prisma.unsubscribeEvent.count({ where: { workspaceId, source: 'COMPLAINT', occurredAt: { gte: since } } }),
  ])

  return verdictFor({ totalSends, bounces, complaints }, t)
}
