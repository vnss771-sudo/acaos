// Cross-customer intelligence (phase 13): pooled, anonymised benchmarks per
// commercial-event kind — "across ACAOS, tender opportunities win 31% of the
// time" — so a workspace can see how its own results compare.
//
// Privacy rules, enforced here:
//   - Opt-in only. A workspace contributes, and can read the benchmarks, only
//     after an admin opts it in (Workspace.networkOptInAt). Default: neither.
//   - Aggregated and anonymised. Only per-kind counts leave a workspace; the
//     published rows carry no workspace id, name, evidence, offer or company.
//   - Anonymity floor. A kind is published only with at least
//     MIN_CONTRIBUTORS (10) contributing workspaces AND MIN_CLOSED (50) closed
//     outcomes. Env vars may raise these floors, never lower them.
//   - No exact pooled counts reach a customer (UQ-30). The stored rows are
//     exact; the read path returns count bands and rates rounded to 5 points,
//     and suppresses a rate unless both sides have MIN_RATE_SIDE observations.
//     A workspace sees its own exact figures beside the pool, so exact pooled
//     totals would let it subtract itself out and learn the peers' totals.
//   - Each workspace's figures are computed inside its own tenant context, so
//     the tenant guard still scopes every query; the pooling is pure.
// The table is recomputed whole (daily); an opt-out takes effect at the next
// recompute.
import { prisma } from './prisma.js'
import { runInWorkspaceContext } from './tenantContext.js'
import { loadCalibrationItems } from './calibrationLearning.js'
import { buildCalibrationReport, type KindFunnel } from './signalCalibration.js'

export const MIN_CONTRIBUTORS = 10
export const MIN_CLOSED = 50
/** A rate is published only when its hits and misses each reach this count. */
export const MIN_RATE_SIDE = 5
const RATE_STEP = 0.05
const COUNT_BANDS = [10, 25, 50, 100, 250, 500, 1000]

function floor(envName: string, min: number): number {
  const n = Number(process.env[envName])
  return Number.isInteger(n) && n > min ? n : min
}
export function networkMinContributors(): number { return floor('NETWORK_MIN_CONTRIBUTORS', MIN_CONTRIBUTORS) }
export function networkMinClosed(): number { return floor('NETWORK_MIN_CLOSED', MIN_CLOSED) }

export type WorkspaceKindCounts = Pick<KindFunnel, 'eventType' | 'opportunities' | 'conversations' | 'closed' | 'won'>

export type NetworkBenchmarkRow = {
  eventType: string
  contributors: number
  opportunities: number
  conversations: number
  closed: number
  won: number
  winRate: number
  conversationRate: number | null
}

const r3 = (x: number) => Math.round(x * 1000) / 1000

/** What a customer sees for one kind: bands and coarse rates, never exact pooled counts. */
export type PublicBenchmarkRow = {
  eventType: string
  contributors: string
  opportunities: string
  closed: string
  winRate: number | null
  conversationRate: number | null
}

/** A count as a coarse band: '10–24', '25–49', … '1000+' ('<10' below the lowest). */
export function countBand(n: number): string {
  for (let i = COUNT_BANDS.length - 1; i >= 0; i--) {
    if (n < COUNT_BANDS[i]) continue
    return i === COUNT_BANDS.length - 1 ? `${COUNT_BANDS[i]}+` : `${COUNT_BANDS[i]}–${COUNT_BANDS[i + 1] - 1}`
  }
  return `<${COUNT_BANDS[0]}`
}

/** hits/total rounded to 5 points, or null when either side is too rare to publish. */
export function publicRate(hits: number, total: number): number | null {
  if (hits < MIN_RATE_SIDE || total - hits < MIN_RATE_SIDE) return null
  return Math.round(Math.round(hits / total / RATE_STEP) * RATE_STEP * 100) / 100
}

export function toPublicBenchmark(row: Pick<NetworkBenchmarkRow, 'eventType' | 'contributors' | 'opportunities' | 'conversations' | 'closed' | 'won'>): PublicBenchmarkRow {
  return {
    eventType: row.eventType,
    contributors: countBand(row.contributors),
    opportunities: countBand(row.opportunities),
    closed: countBand(row.closed),
    winRate: publicRate(row.won, row.closed),
    conversationRate: row.opportunities ? publicRate(row.conversations, row.opportunities) : null,
  }
}

/**
 * Pool per-workspace counts into per-kind benchmarks. A workspace contributes
 * to a kind only with at least one closed outcome of it; kinds below either
 * floor are withheld entirely. Input order and identity never reach the output.
 */
export function poolBenchmarks(
  perWorkspace: WorkspaceKindCounts[][],
  opts: { minContributors?: number; minClosed?: number } = {},
): NetworkBenchmarkRow[] {
  const minContributors = Math.max(MIN_CONTRIBUTORS, opts.minContributors ?? MIN_CONTRIBUTORS)
  const minClosed = Math.max(MIN_CLOSED, opts.minClosed ?? MIN_CLOSED)
  const byKind = new Map<string, { contributors: number; opportunities: number; conversations: number; closed: number; won: number }>()
  for (const funnels of perWorkspace) {
    for (const f of funnels) {
      if (f.closed <= 0) continue
      const k = byKind.get(f.eventType) ?? { contributors: 0, opportunities: 0, conversations: 0, closed: 0, won: 0 }
      k.contributors++
      k.opportunities += f.opportunities
      k.conversations += f.conversations
      k.closed += f.closed
      k.won += f.won
      byKind.set(f.eventType, k)
    }
  }
  return [...byKind.entries()]
    .filter(([, k]) => k.contributors >= minContributors && k.closed >= minClosed)
    .map(([eventType, k]) => ({
      eventType, ...k,
      winRate: r3(k.won / k.closed),
      conversationRate: k.opportunities ? r3(k.conversations / k.opportunities) : null,
    }))
    .sort((a, b) => a.eventType.localeCompare(b.eventType))
}

/** Recompute the whole benchmark table from opted-in workspaces. */
export async function computeNetworkBenchmarks(opts: { now?: Date } = {}): Promise<{ workspaces: number; published: number; withheld: number }> {
  const now = opts.now ?? new Date()
  const optedIn = await prisma.workspace.findMany({
    where: { networkOptInAt: { not: null } },
    select: { id: true },
  }) as Array<{ id: string }>

  const perWorkspace: WorkspaceKindCounts[][] = []
  for (const w of optedIn) {
    const report = await runInWorkspaceContext(w.id, async () => buildCalibrationReport(await loadCalibrationItems(w.id, { now })))
    perWorkspace.push(report.funnels.map(({ eventType, opportunities, conversations, closed, won }) => ({ eventType, opportunities, conversations, closed, won })))
  }
  const rows = poolBenchmarks(perWorkspace, { minContributors: networkMinContributors(), minClosed: networkMinClosed() })
  const kinds = new Set(perWorkspace.flat().filter(f => f.closed > 0).map(f => f.eventType))

  await prisma.$transaction(async (tx) => {
    await tx.networkBenchmark.deleteMany({})
    if (rows.length) await tx.networkBenchmark.createMany({ data: rows.map(r => ({ ...r, computedAt: now })) })
  })
  return { workspaces: optedIn.length, published: rows.length, withheld: kinds.size - rows.length }
}

export class NetworkAccessError extends Error {
  constructor(public status: 403 | 404, message: string) { super(message) }
}

/** The benchmarks beside the workspace's own figures. Opted-in workspaces only. */
export async function loadNetworkBenchmarks(workspaceId: string, opts: { now?: Date } = {}): Promise<{
  optedInAt: string
  benchmarks: Array<PublicBenchmarkRow & { computedAt: string; yours: { closed: number; won: number; winRate: number | null } | null }>
}> {
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { networkOptInAt: true } }) as { networkOptInAt: Date | null } | null
  if (!ws) throw new NetworkAccessError(404, 'Workspace not found')
  if (!ws.networkOptInAt) throw new NetworkAccessError(403, 'Opt in to cross-customer intelligence to see the benchmarks — only contributing workspaces can')
  const [rows, own] = await Promise.all([
    prisma.networkBenchmark.findMany({ orderBy: { eventType: 'asc' } }) as Promise<Array<NetworkBenchmarkRow & { computedAt: Date }>>,
    loadCalibrationItems(workspaceId, opts).then(items => buildCalibrationReport(items)),
  ])
  const mine = new Map(own.funnels.map(f => [f.eventType, f]))
  return {
    optedInAt: ws.networkOptInAt.toISOString(),
    benchmarks: rows.map((row) => {
      const m = mine.get(row.eventType)
      return {
        ...toPublicBenchmark(row),
        computedAt: row.computedAt.toISOString(),
        yours: m ? { closed: m.closed, won: m.won, winRate: m.winRate } : null,
      }
    }),
  }
}

/** Whether the workspace shares its outcomes. Unlike the benchmarks, readable before opting in. */
export async function loadNetworkParticipation(workspaceId: string): Promise<{ optedInAt: string | null }> {
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { networkOptInAt: true } }) as { networkOptInAt: Date | null } | null
  if (!ws) throw new NetworkAccessError(404, 'Workspace not found')
  return { optedInAt: ws.networkOptInAt?.toISOString() ?? null }
}

export async function setNetworkParticipation(workspaceId: string, optIn: boolean, now: Date = new Date()): Promise<{ optedInAt: string | null }> {
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { networkOptInAt: true } }) as { networkOptInAt: Date | null } | null
  if (!ws) throw new NetworkAccessError(404, 'Workspace not found')
  // Keep the original opt-in time while staying in; clear it on opt-out.
  const next = optIn ? ws.networkOptInAt ?? now : null
  if ((next?.getTime() ?? null) !== (ws.networkOptInAt?.getTime() ?? null)) {
    await prisma.workspace.update({ where: { id: workspaceId }, data: { networkOptInAt: next } })
  }
  return { optedInAt: next?.toISOString() ?? null }
}
