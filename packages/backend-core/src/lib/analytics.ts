import { prisma } from './prisma.js'
import { logger } from './logger.js'
import type { Prisma, PrismaClient } from '@prisma/client'

// First-party product analytics. Deliberately NOT a PostHog/Segment integration: a
// third-party SDK adds a dependency (and the dependency-review gate already rejected
// one heavy transitive tree) and egress, while a first-party event stream keeps
// funnels queryable in-product with nothing leaving the boundary.

type Db = PrismaClient | Prisma.TransactionClient

export type AnalyticsEventInput = {
  name: string
  workspaceId?: string | null
  userId?: string | null
  properties?: Record<string, unknown>
}

// Best-effort: analytics must never break the action it instruments (mirrors
// recordAudit). Fire-and-forget at call sites — no await needed.
export async function trackEvent(e: AnalyticsEventInput, client: Db = prisma): Promise<void> {
  try {
    await client.analyticsEvent.create({
      data: {
        name: e.name,
        workspaceId: e.workspaceId ?? null,
        userId: e.userId ?? null,
        properties: (e.properties ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    })
  } catch (err) {
    logger.warn('analytics event failed to record', { name: e.name, error: (err as Error).message })
  }
}

// The activation funnel: the ordered stages a workspace passes through to first
// value. Each key is the event name emitted at that milestone.
export const ACTIVATION_STAGES = [
  { key: 'signup', label: 'Signed up' },
  { key: 'icp.configured', label: 'ICP configured' },
  { key: 'campaign.sent', label: 'First send' },
  { key: 'reply.received', label: 'First reply' },
] as const
export type ActivationStageKey = (typeof ACTIVATION_STAGES)[number]['key']

export type FunnelStage = {
  key: string
  label: string
  count: number
  // Fraction of the previous stage that reached this one (1 for the top stage).
  conversionFromPrev: number
  // Fraction of the top-of-funnel that reached this stage.
  conversionFromTop: number
}

const round2 = (n: number): number => Math.round(n * 100) / 100

// Pure: given the distinct-workspace count reached at each stage, compute per-stage
// conversion (from the previous stage and from the top of the funnel). Unit-tested.
export function computeActivationFunnel(counts: Record<string, number>): FunnelStage[] {
  const top = counts[ACTIVATION_STAGES[0].key] ?? 0
  let prev = top
  return ACTIVATION_STAGES.map((s, i) => {
    const count = counts[s.key] ?? 0
    const conversionFromPrev = i === 0 ? 1 : prev > 0 ? round2(count / prev) : 0
    const conversionFromTop = top > 0 ? round2(count / top) : 0
    prev = count
    return { key: s.key, label: s.label, count, conversionFromPrev, conversionFromTop }
  })
}

// Count the distinct workspaces that reached each activation stage, then compute the
// funnel. One indexed query per stage (bounded by stage count); each uses the
// (name, occurredAt) / (workspaceId, name) indexes.
export async function getActivationFunnel(client: Db = prisma): Promise<FunnelStage[]> {
  const counts: Record<string, number> = {}
  for (const s of ACTIVATION_STAGES) {
    const rows = await client.analyticsEvent.findMany({
      where: { name: s.key, workspaceId: { not: null } },
      distinct: ['workspaceId'],
      select: { workspaceId: true },
    })
    counts[s.key] = rows.length
  }
  return computeActivationFunnel(counts)
}
