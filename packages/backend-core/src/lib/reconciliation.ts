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

type FieldCounts = Record<CampaignStatField, number>
const zeroCounts = (): FieldCounts => ({ sent: 0, replied: 0, interested: 0, bounced: 0, unsubscribed: 0, failed: 0 })

/** Ledger-side buckets for one workspace: (campaignId, day) -> field counts. */
async function ledgerBucketsForWorkspace(workspaceId: string, since: Date, until: Date): Promise<Map<string, { campaignId: string; counts: FieldCounts }>> {
  // Scoped by workspaceId first — the same shape rebuildCampaignStats already
  // uses, which hits the @@index([workspaceId, campaignId, occurredAt]) index
  // instead of the unscoped, cross-tenant sequential scan this replaced.
  const events = await prisma.contactEvent.findMany({
    where: { workspaceId, campaignId: { not: null }, occurredAt: { gte: since, lt: until } },
    select: { campaignId: true, type: true, occurredAt: true },
  })
  const ledger = new Map<string, { campaignId: string; counts: FieldCounts }>()
  for (const e of events) {
    const field = EVENT_FIELD[e.type]
    if (!field || !e.campaignId) continue
    const date = utcDayStart(e.occurredAt)
    const key = `${e.campaignId}:${date.toISOString()}`
    let b = ledger.get(key)
    if (!b) {
      b = { campaignId: e.campaignId, counts: zeroCounts() }
      ledger.set(key, b)
    }
    b.counts[field]++
  }
  return ledger
}

/**
 * Compare the ledger aggregate against CampaignDailyStats over the trailing window.
 * Returns the drifts found; when `rebuild` is true, rebuilds each drifted
 * workspace's stats from the ledger (idempotent). Bounded by `since`.
 */
export async function reconcileCampaignStats(opts: { rebuild?: boolean; now?: Date } = {}): Promise<ReconcileReport> {
  const now = opts.now ?? new Date()
  // Reconcile only SETTLED days. `until` is the start of the current UTC day, so the
  // current (partial) day is excluded: the ledger and projection are read in two
  // separate queries, and a send committing between them would otherwise surface as
  // transient false drift on today's row and trigger an unnecessary rebuild on every
  // sweep. Today is live-maintained (ledger + projection written in one transaction)
  // and gets reconciled tomorrow once it has settled.
  const until = utcDayStart(now)
  const since = utcDayStart(new Date(now.getTime() - reconcileWindowDays() * 24 * 60 * 60 * 1000))

  // Every query below is scoped to one workspace at a time — this sweep used to
  // load every ContactEvent in the window across every tenant into one JS Map with
  // no workspaceId filter and no supporting index, which at real send volume is
  // both a full cross-tenant table scan and an OOM risk for the worker process
  // that also runs every other queue. Two cheap `distinct` queries first find which
  // workspaces have anything to check in the window (a workspace can show up via
  // the ledger, the projection, or both — e.g. a lost live-projection write leaves
  // ledger events with no matching row at all, which is exactly the drift case
  // this sweep exists to catch).
  const [ledgerWorkspaces, projectionWorkspaces] = await Promise.all([
    prisma.contactEvent.findMany({
      where: { campaignId: { not: null }, occurredAt: { gte: since, lt: until } },
      distinct: ['workspaceId'],
      select: { workspaceId: true },
    }),
    prisma.campaignDailyStats.findMany({
      where: { date: { gte: since, lt: until } },
      distinct: ['workspaceId'],
      select: { workspaceId: true },
    }),
  ])
  const workspaceIds = new Set<string>([
    ...ledgerWorkspaces.map((w: { workspaceId: string }) => w.workspaceId),
    ...projectionWorkspaces.map((w: { workspaceId: string }) => w.workspaceId),
  ])

  const drifted: ReconcileReport['drifted'] = []
  const driftedWorkspaces = new Set<string>()
  let campaignsChecked = 0

  for (const workspaceId of workspaceIds) {
    const [ledger, rows] = await Promise.all([
      ledgerBucketsForWorkspace(workspaceId, since, until),
      prisma.campaignDailyStats.findMany({ where: { workspaceId, date: { gte: since, lt: until } } }),
    ])
    const projection = new Map<string, FieldCounts>()
    for (const r of rows as Array<Record<string, unknown>>) {
      const key = `${r.campaignId as string}:${(r.date as Date).toISOString()}`
      projection.set(key, {
        sent: r.sent as number, replied: r.replied as number, interested: r.interested as number,
        bounced: r.bounced as number, unsubscribed: r.unsubscribed as number, failed: r.failed as number,
      })
    }

    const allKeys = new Set<string>([...ledger.keys(), ...projection.keys()])
    campaignsChecked += allKeys.size
    for (const key of allKeys) {
      const b = ledger.get(key)
      const proj = projection.get(key) ?? zeroCounts()
      const counts = b?.counts ?? zeroCounts()
      for (const field of FIELDS) {
        if (counts[field] !== proj[field]) {
          const [campaignId, dateIso] = key.split(/:(?=\d{4}-)/)
          drifted.push({ campaignId, date: dateIso, field, ledger: counts[field], projection: proj[field] })
          driftedWorkspaces.add(workspaceId)
        }
      }
    }
  }

  let workspacesRebuilt = 0
  if (opts.rebuild) {
    for (const workspaceId of driftedWorkspaces) {
      // Bound the rebuild to the same settled-day window so it never re-derives (and
      // races) today's live-maintained row.
      await rebuildCampaignStats(workspaceId, since, until).catch(() => {})
      workspacesRebuilt++
    }
  }

  return { campaignsChecked, drifted, workspacesRebuilt }
}
