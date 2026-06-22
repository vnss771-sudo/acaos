// Plan enforcement: AI call limits and lead count caps per billing tier
import type { PrismaClient, Prisma } from '@prisma/client'
import type { BillingPlan } from '@acaos/shared'
import { prisma } from './prisma.js'
import { ApiError } from './errors.js'
import { estimateDiscoveryCost, type DiscoveryCostBreakdown } from './discoveryCost.js'

// Either the singleton client or an interactive-transaction client.
type Db = PrismaClient | Prisma.TransactionClient

export type UsageAction = 'AI_RESEARCH' | 'AI_OUTREACH' | 'AI_REPLY'
const AI_ACTIONS: string[] = ['AI_RESEARCH', 'AI_OUTREACH', 'AI_REPLY']
const DISCOVERY_ACTION = 'DISCOVERY'

const PLAN_LIMITS = {
  free: { aiCallsPerMonth: 15, maxLeads: 500, discoveriesPerMonth: 25 },
  starter: { aiCallsPerMonth: 300, maxLeads: 10_000, discoveriesPerMonth: 500 },
  growth: { aiCallsPerMonth: Infinity, maxLeads: Infinity, discoveriesPerMonth: Infinity }
} as const

type Plan = BillingPlan

function currentMonth(): string {
  // Use UTC so the monthly quota window rolls over at the same instant for every
  // workspace regardless of the server's local timezone (a tz change or a deploy
  // in another region must not shift the billing-period boundary).
  const d = new Date()
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/**
 * Start of the current UTC calendar month for `now` — the window boundary for the
 * monthly send ceiling. UTC for the same reason as currentMonth(). Pure.
 */
export function utcMonthStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
}

function resolvePlan(plan: string | null | undefined): Plan {
  if (plan === 'starter' || plan === 'growth') return plan
  return 'free'
}

async function getWorkspacePlan(workspaceId: string, client: Db = prisma): Promise<Plan> {
  const ws = await client.workspace.findUnique({
    where: { id: workspaceId },
    select: { plan: true, subscriptionStatus: true }
  })
  // Treat lapsed subscriptions as free
  if (ws?.subscriptionStatus && ws.subscriptionStatus !== 'active') return 'free'
  return resolvePlan(ws?.plan)
}

export async function checkAndIncrementAiUsage(workspaceId: string, action: UsageAction): Promise<void> {
  const plan = await getWorkspacePlan(workspaceId)
  const { aiCallsPerMonth } = PLAN_LIMITS[plan]
  const month = currentMonth()

  // Serialize the read-then-increment per workspace with a transaction-scoped
  // advisory lock, so concurrent requests can't both pass the check and exceed
  // the limit (the previous plain read-then-upsert had a check-then-increment
  // race). The lock is released automatically when the transaction ends.
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}))`

    if (isFinite(aiCallsPerMonth)) {
      const records = await tx.usageRecord.findMany({ where: { workspaceId, month, action: { in: AI_ACTIONS } } })
      const used = (records as Array<{ count: number }>).reduce((s: number, r: { count: number }) => s + r.count, 0)
      if (used >= aiCallsPerMonth) {
        throw new ApiError(
          429,
          `Monthly AI limit reached (${aiCallsPerMonth} calls/month on ${plan} plan). ` +
          `Upgrade to unlock more.`
        )
      }
    }

    await tx.usageRecord.upsert({
      where: { workspaceId_month_action: { workspaceId, month, action } },
      create: { workspaceId, month, action, count: 1 },
      update: { count: { increment: 1 } }
    })
  })
}

// Refund one unit of this month's AI usage for `action`. Used when an AI call
// was reserved (checkAndIncrementAiUsage) but produced no usable result, so a
// workspace's quota is only spent on output it can actually use — generation
// failures are the platform's cost, not the customer's. Floors at zero (the
// `count > 0` guard) so a refund can never create a negative balance.
export async function refundAiUsage(workspaceId: string, action: UsageAction): Promise<void> {
  const month = currentMonth()
  await prisma.usageRecord.updateMany({
    where: { workspaceId, month, action, count: { gt: 0 } },
    data: { count: { decrement: 1 } },
  })
}

// Per-workspace monthly discovery quota. Discovery providers use platform-level
// API keys, so an unbounded workspace is a real cost/abuse risk. Mirrors the AI
// check: advisory-locked read-then-increment so concurrent runs can't overshoot.
export async function checkAndIncrementDiscoveryUsage(workspaceId: string): Promise<void> {
  const plan = await getWorkspacePlan(workspaceId)
  const { discoveriesPerMonth } = PLAN_LIMITS[plan]
  const month = currentMonth()

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`disc:${workspaceId}`}))`

    if (isFinite(discoveriesPerMonth)) {
      const record = await tx.usageRecord.findUnique({
        where: { workspaceId_month_action: { workspaceId, month, action: DISCOVERY_ACTION } },
      })
      const used = record?.count ?? 0
      if (used >= discoveriesPerMonth) {
        throw new ApiError(
          429,
          `Monthly discovery limit reached (${discoveriesPerMonth} runs/month on ${plan} plan). Upgrade to run more.`
        )
      }
    }

    await tx.usageRecord.upsert({
      where: { workspaceId_month_action: { workspaceId, month, action: DISCOVERY_ACTION } },
      create: { workspaceId, month, action: DISCOVERY_ACTION, count: 1 },
      update: { count: { increment: 1 } },
    })
  })
}

export async function checkLeadLimit(workspaceId: string): Promise<void> {
  const plan = await getWorkspacePlan(workspaceId)
  const { maxLeads } = PLAN_LIMITS[plan]
  if (!isFinite(maxLeads)) return

  const count = await prisma.lead.count({ where: { workspaceId } })
  if (count >= maxLeads) {
    throw new ApiError(
      429,
      `Lead limit reached (${maxLeads} leads on ${plan} plan). Upgrade to add more leads.`
    )
  }
}

/**
 * Atomically determine how many of `requested` new leads a workspace may create
 * without exceeding its plan cap. MUST be called inside an interactive
 * transaction; it takes a per-workspace advisory lock so concurrent batch
 * imports cannot each pass an independent check and collectively overshoot the
 * limit. Returns the number permitted (clamped to 0..requested); unlimited plans
 * pass `requested` straight through. The caller inserts exactly the returned
 * count within the same transaction so the count-then-insert stays atomic.
 */
export async function reserveLeadCapacity(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  requested: number
): Promise<number> {
  if (requested <= 0) return 0
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}))`
  const plan = await getWorkspacePlan(workspaceId, tx)
  const { maxLeads } = PLAN_LIMITS[plan]
  if (!isFinite(maxLeads)) return requested
  const count = await tx.lead.count({ where: { workspaceId } })
  return Math.max(0, Math.min(requested, maxLeads - count))
}

/**
 * Atomically decide whether the workspace may send one more email today without
 * exceeding `dailyLimit`. MUST be called inside an interactive transaction; the
 * caller inserts the outbox claim within the SAME transaction so the
 * count-then-claim is atomic. A per-workspace advisory lock (namespaced `send:`
 * so it never contends with the AI/lead/discovery locks) serializes concurrent
 * send jobs for the workspace, so two campaigns can't each pass an independent
 * cap check and collectively overshoot the daily limit. Counts today's delivered
 * (SENT) plus in-flight (SENDING) claims — fail-closed; FAILED rows are excluded
 * so a failed attempt doesn't permanently burn a slot.
 */
export async function reserveDailySendSlot(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  dailyLimit: number,
  since: Date
): Promise<boolean> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`send:${workspaceId}`}))`
  const used = await tx.outreachSent.count({
    where: { workspaceId, status: { in: ['SENT', 'SENDING'] }, sentAt: { gte: since } },
  })
  return used < dailyLimit
}

// Start of the current month in UTC — matches the UTC month window used by the
// usage counters so the discovery-cost view lines up with the quota period.
function startOfMonthUtc(): Date {
  const d = new Date()
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
}

// Estimated weighted discovery spend for the workspace this month, derived from
// the recorded DiscoveryRun history (no extra tracking). Every run that reached
// a provider counts — including failed ones, which still cost the platform.
export async function getMonthlyDiscoveryCost(workspaceId: string): Promise<DiscoveryCostBreakdown> {
  const grouped = await prisma.discoveryRun.groupBy({
    by: ['source'],
    where: { workspaceId, startedAt: { gte: startOfMonthUtc() } },
    _count: true,
  })
  return estimateDiscoveryCost(
    (grouped as Array<{ source: string; _count: number }>).map((g) => ({ source: g.source, count: g._count }))
  )
}

export async function getMonthlyUsage(workspaceId: string): Promise<{
  month: string
  totals: Record<UsageAction, number>
  total: number
  limit: number
  plan: Plan
  discovery: { used: number; limit: number; estimatedCostCents: number; byProvider: DiscoveryCostBreakdown['byProvider'] }
  leads: { used: number; limit: number }
}> {
  const plan = await getWorkspacePlan(workspaceId)
  const month = currentMonth()
  const [records, leadsUsed, discoveryCost] = await Promise.all([
    prisma.usageRecord.findMany({ where: { workspaceId, month } }),
    prisma.lead.count({ where: { workspaceId } }),
    getMonthlyDiscoveryCost(workspaceId),
  ])

  const totals: Record<UsageAction, number> = {
    AI_RESEARCH: 0,
    AI_OUTREACH: 0,
    AI_REPLY: 0
  }
  let discoveryUsed = 0
  for (const r of records) {
    if (r.action in totals) totals[r.action as UsageAction] = r.count
    else if (r.action === DISCOVERY_ACTION) discoveryUsed = r.count
  }

  const total = Object.values(totals).reduce((s, v) => s + v, 0)
  const limit = PLAN_LIMITS[plan].aiCallsPerMonth
  const norm = (n: number) => (isFinite(n) ? n : -1) // -1 = unlimited

  return {
    month, totals, total, limit: norm(limit), plan,
    discovery: {
      used: discoveryUsed,
      limit: norm(PLAN_LIMITS[plan].discoveriesPerMonth),
      estimatedCostCents: discoveryCost.totalCents,
      byProvider: discoveryCost.byProvider,
    },
    leads: { used: leadsUsed, limit: norm(PLAN_LIMITS[plan].maxLeads) },
  }
}

export function getPlanInfo(plan: string) {
  const p = resolvePlan(plan)
  return { ...PLAN_LIMITS[p], plan: p }
}

export type PlanCatalogEntry = {
  maxLeads: number | null
  aiCallsPerMonth: number | null
  discoveriesPerMonth: number | null
}

// JSON-safe catalog of EVERY plan's limits (Infinity -> null = "unlimited"), so
// the frontend renders the plan-comparison numbers from the SAME source the
// backend enforces instead of hardcoding them (the single source of truth — see
// GET /api/billing/plans and apps/web/src/views/Billing.tsx).
export function getPlanCatalog(): Record<Plan, PlanCatalogEntry> {
  const norm = (n: number): number | null => (isFinite(n) ? n : null)
  const out = {} as Record<Plan, PlanCatalogEntry>
  for (const plan of Object.keys(PLAN_LIMITS) as Plan[]) {
    const l = PLAN_LIMITS[plan]
    out[plan] = {
      maxLeads: norm(l.maxLeads),
      aiCallsPerMonth: norm(l.aiCallsPerMonth),
      discoveriesPerMonth: norm(l.discoveriesPerMonth),
    }
  }
  return out
}
