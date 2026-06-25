import type { Prisma, PrismaClient } from '@prisma/client'
import { prisma } from './prisma.js'

// CampaignDailyStats read-model maintenance. The ContactEvent ledger is the source
// of truth; these counters are a fast projection, live-incremented in the same
// transaction as the lifecycle write and fully rebuildable from the ledger.

export type CampaignStatField = 'sent' | 'replied' | 'interested' | 'bounced' | 'unsubscribed' | 'failed'

type Db = PrismaClient | Prisma.TransactionClient

/** UTC start-of-day for `d` — the bucket key for CampaignDailyStats.date. */
export function utcDayStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

/**
 * Build the upsert args to increment one daily-stats field by `by`. Returned
 * (not executed) so a caller can drop it into a `prisma.$transaction([...])` array
 * and have the counter commit atomically with the lifecycle write it counts.
 */
export function campaignDailyStatsUpsertArgs(input: {
  workspaceId: string
  campaignId: string
  date: Date
  field: CampaignStatField
  by?: number
}): Prisma.CampaignDailyStatsUpsertArgs {
  const by = input.by ?? 1
  const date = utcDayStart(input.date)
  const create: Record<string, unknown> = { workspaceId: input.workspaceId, campaignId: input.campaignId, date }
  create[input.field] = by
  const update: Record<string, unknown> = {}
  update[input.field] = { increment: by }
  return {
    where: { campaignId_date: { campaignId: input.campaignId, date } },
    create: create as Prisma.CampaignDailyStatsCreateInput,
    update: update as Prisma.CampaignDailyStatsUpdateInput,
  }
}

/** Execute a single-field increment (interactive tx or the singleton client). */
export async function incrementCampaignDailyStats(
  client: Db,
  input: { workspaceId: string; campaignId: string; date: Date; field: CampaignStatField; by?: number }
): Promise<void> {
  await client.campaignDailyStats.upsert(campaignDailyStatsUpsertArgs(input))
}

export type CampaignStatTotals = {
  sent: number; replied: number; interested: number; bounced: number; unsubscribed: number; failed: number
}

/**
 * Sum a campaign's lifetime stats from the CampaignDailyStats projection in a single
 * indexed aggregate, instead of N growing count()s over the ever-expanding
 * OutreachSent table. The projection is transactionally maintained with each send and
 * reconciled from the ledger, so it is the right source for dashboards at scale.
 */
export async function sumCampaignStats(campaignId: string, client: Db = prisma): Promise<CampaignStatTotals> {
  const agg = await client.campaignDailyStats.aggregate({
    where: { campaignId },
    _sum: { sent: true, replied: true, interested: true, bounced: true, unsubscribed: true, failed: true },
  })
  const s = agg._sum
  return {
    sent: s.sent ?? 0,
    replied: s.replied ?? 0,
    interested: s.interested ?? 0,
    bounced: s.bounced ?? 0,
    unsubscribed: s.unsubscribed ?? 0,
    failed: s.failed ?? 0,
  }
}

// Map a ContactEvent.type to the stats field it increments (for live + rebuild).
export const EVENT_FIELD: Record<string, CampaignStatField | undefined> = {
  SENT: 'sent',
  REPLIED: 'replied',
  BOUNCED: 'bounced',
  UNSUBSCRIBED: 'unsubscribed',
  FAILED: 'failed',
}

/**
 * Rebuild CampaignDailyStats for a workspace by re-aggregating the ContactEvent
 * ledger over an optional [from, to) window. Idempotent: it re-sums the affected
 * rows' counters, so a drifted projection converges to the ledger. `to` lets a
 * caller exclude the current (partial) day so a rebuild never races a live write.
 * Used by ops/rebuild-campaign-stats.mjs and the reconciliation sweep.
 */
export async function rebuildCampaignStats(workspaceId: string, from?: Date, to?: Date): Promise<{ rows: number }> {
  const occurredAt: { gte?: Date; lt?: Date } = {}
  if (from) occurredAt.gte = from
  if (to) occurredAt.lt = to
  const events = await prisma.contactEvent.findMany({
    where: {
      workspaceId,
      campaignId: { not: null },
      ...(from || to ? { occurredAt } : {}),
    },
    select: { campaignId: true, type: true, occurredAt: true },
  })

  // Accumulate counts per (campaignId, utc-day).
  const buckets = new Map<string, { campaignId: string; date: Date; counts: Record<CampaignStatField, number> }>()
  for (const e of events) {
    const field = EVENT_FIELD[e.type]
    if (!field || !e.campaignId) continue
    const date = utcDayStart(e.occurredAt)
    const key = `${e.campaignId}:${date.toISOString()}`
    let b = buckets.get(key)
    if (!b) {
      b = { campaignId: e.campaignId, date, counts: { sent: 0, replied: 0, interested: 0, bounced: 0, unsubscribed: 0, failed: 0 } }
      buckets.set(key, b)
    }
    b.counts[field]++
  }

  let rows = 0
  for (const b of buckets.values()) {
    await prisma.campaignDailyStats.upsert({
      where: { campaignId_date: { campaignId: b.campaignId, date: b.date } },
      create: { workspaceId, campaignId: b.campaignId, date: b.date, ...b.counts },
      update: { ...b.counts },
    })
    rows++
  }
  return { rows }
}
