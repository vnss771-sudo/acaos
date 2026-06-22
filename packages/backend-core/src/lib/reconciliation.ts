import { prisma } from './prisma.js'
import { utcDayStart, EVENT_FIELD, rebuildCampaignStats, type CampaignStatField } from './campaignStats.js'

// Ledger ↔ projection reconciliation. CampaignDailyStats is a live-incremented
// projection of the ContactEvent ledger (the source of truth). They can drift if a
// projection write is ever lost, or a send/event row is manually deleted. This job
// re-aggregates the ledger over a recent window, compares it to the projection, and
// (optionally) rebuilds any workspace that drifted — turning the manual
// rebuildCampaignStats op into a periodic safety net.
//
// OPT-IN: gated by STATS_RECONCILE_ENABLED (default off), wired into the worker's
// daily maintenance sweep. Read-mostly; only writes via rebuildCampaignStats.

export function reconcileEnabled(): boolean {
  const raw = (process.env.STATS_RECONCILE_ENABLED || '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

// How far back to reconcile. Stats are append-mostly; old days don't change, so a
// short trailing window keeps the ledger scan bounded. Default 2 days.
export function reconcileWindowDays(): number {
  const n = Number(process.env.STATS_RECONCILE_WINDOW_DAYS)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 2
}

export interface ReconcileReport {
  campaignsChecked: number
  drifted: Array<{ campaignId: string; date: string; field: CampaignStatField; ledger: number; projection: number }>
  workspacesRebuilt: number
}

const FIELDS: CampaignStatField[] = ['sent', 'replied', 'interested', 'bounced', 'unsubscribed', 'failed']

/**
 * Compare the ledger aggregate against CampaignDailyStats over the trailing window.
 * Returns the drifts found; when `rebuild` is true, rebuilds each drifted
 * workspace's stats from the ledger (idempotent). Bounded by `since`.
 */
export async function reconcileCampaignStats(opts: { rebuild?: boolean; now?: Date } = {}): Promise<ReconcileReport> {
  const now = opts.now ?? new Date()
  const since = utcDayStart(new Date(now.getTime() - reconcileWindowDays() * 24 * 60 * 60 * 1000))

  // Ledger side: events in the window, bucketed by (workspace, campaign, day, field).
  const events = await prisma.contactEvent.findMany({
    where: { campaignId: { not: null }, occurredAt: { gte: since } },
    select: { workspaceId: true, campaignId: true, type: true, occurredAt: true },
  })
  const ledger = new Map<string, { workspaceId: string; campaignId: string; date: Date; counts: Record<CampaignStatField, number> }>()
  for (const e of events) {
    const field = EVENT_FIELD[e.type]
    if (!field || !e.campaignId) continue
    const date = utcDayStart(e.occurredAt)
    const key = `${e.campaignId}:${date.toISOString()}`
    let b = ledger.get(key)
    if (!b) {
      b = { workspaceId: e.workspaceId, campaignId: e.campaignId, date, counts: { sent: 0, replied: 0, interested: 0, bounced: 0, unsubscribed: 0, failed: 0 } }
      ledger.set(key, b)
    }
    b.counts[field]++
  }

  // Projection side: the stored rows over the same window.
  const rows = await prisma.campaignDailyStats.findMany({ where: { date: { gte: since } } })
  const projection = new Map<string, Record<CampaignStatField, number>>()
  for (const r of rows as Array<Record<string, unknown>>) {
    const key = `${r.campaignId as string}:${(r.date as Date).toISOString()}`
    projection.set(key, {
      sent: r.sent as number, replied: r.replied as number, interested: r.interested as number,
      bounced: r.bounced as number, unsubscribed: r.unsubscribed as number, failed: r.failed as number,
    })
  }

  const drifted: ReconcileReport['drifted'] = []
  const driftedWorkspaces = new Set<string>()
  // Union of keys present in either side.
  const allKeys = new Set<string>([...ledger.keys(), ...projection.keys()])
  for (const key of allKeys) {
    const b = ledger.get(key)
    const proj = projection.get(key) ?? { sent: 0, replied: 0, interested: 0, bounced: 0, unsubscribed: 0, failed: 0 }
    const counts = b?.counts ?? { sent: 0, replied: 0, interested: 0, bounced: 0, unsubscribed: 0, failed: 0 }
    for (const field of FIELDS) {
      if (counts[field] !== proj[field]) {
        const [campaignId, dateIso] = key.split(/:(?=\d{4}-)/)
        drifted.push({ campaignId, date: dateIso, field, ledger: counts[field], projection: proj[field] })
        if (b) driftedWorkspaces.add(b.workspaceId)
        else {
          // Projection has a row the ledger window doesn't explain; capture workspace from the stored row.
          const wsRow = (rows as Array<Record<string, unknown>>).find((r) => `${r.campaignId}:${(r.date as Date).toISOString()}` === key)
          if (wsRow) driftedWorkspaces.add(wsRow.workspaceId as string)
        }
      }
    }
  }

  let workspacesRebuilt = 0
  if (opts.rebuild) {
    for (const workspaceId of driftedWorkspaces) {
      await rebuildCampaignStats(workspaceId, since).catch(() => {})
      workspacesRebuilt++
    }
  }

  return { campaignsChecked: allKeys.size, drifted, workspacesRebuilt }
}
