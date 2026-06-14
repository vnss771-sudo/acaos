// Plan enforcement: AI call limits and lead count caps per billing tier
import { prisma } from './prisma.js'
import { ApiError } from './http.js'

export type UsageAction = 'AI_RESEARCH' | 'AI_OUTREACH' | 'AI_REPLY'

const PLAN_LIMITS = {
  free: { aiCallsPerMonth: 15, maxLeads: 500 },
  starter: { aiCallsPerMonth: 300, maxLeads: 10_000 },
  growth: { aiCallsPerMonth: Infinity, maxLeads: Infinity }
} as const

type Plan = keyof typeof PLAN_LIMITS

function currentMonth(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function resolvePlan(plan: string | null | undefined): Plan {
  if (plan === 'starter' || plan === 'growth') return plan
  return 'free'
}

async function getWorkspacePlan(workspaceId: string): Promise<Plan> {
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { plan: true, subscriptionStatus: true }
  })
  // Treat lapsed subscriptions as free
  if (ws?.subscriptionStatus && ws.subscriptionStatus !== 'active') return 'free'
  return resolvePlan(ws?.plan)
}

async function getMonthlyAiCount(workspaceId: string): Promise<number> {
  const month = currentMonth()
  const records = await prisma.usageRecord.findMany({
    where: { workspaceId, month }
  })
  return (records as Array<{ count: number }>).reduce((s: number, r: { count: number }) => s + r.count, 0)
}

export async function checkAndIncrementAiUsage(workspaceId: string, action: UsageAction): Promise<void> {
  const plan = await getWorkspacePlan(workspaceId)
  const { aiCallsPerMonth } = PLAN_LIMITS[plan]
  const month = currentMonth()

  // Serialize the read-then-increment per workspace with a transaction-scoped
  // advisory lock, so concurrent requests can't both pass the check and exceed
  // the limit (the previous plain read-then-upsert had a check-then-increment
  // race). The lock is released automatically when the transaction ends.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}))`

    if (isFinite(aiCallsPerMonth)) {
      const records = await tx.usageRecord.findMany({ where: { workspaceId, month } })
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

export async function getMonthlyUsage(workspaceId: string): Promise<{
  month: string
  totals: Record<UsageAction, number>
  total: number
  limit: number
  plan: Plan
}> {
  const plan = await getWorkspacePlan(workspaceId)
  const month = currentMonth()
  const records = await prisma.usageRecord.findMany({ where: { workspaceId, month } })

  const totals: Record<UsageAction, number> = {
    AI_RESEARCH: 0,
    AI_OUTREACH: 0,
    AI_REPLY: 0
  }
  for (const r of records) {
    if (r.action in totals) totals[r.action as UsageAction] = r.count
  }

  const total = Object.values(totals).reduce((s, v) => s + v, 0)
  const limit = PLAN_LIMITS[plan].aiCallsPerMonth

  return { month, totals, total, limit: isFinite(limit) ? limit : -1, plan }
}

export function getPlanInfo(plan: string) {
  const p = resolvePlan(plan)
  return { ...PLAN_LIMITS[p], plan: p }
}
