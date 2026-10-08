// Discovery source health (UQ-13): is a source merely reachable, or fresh,
// structurally healthy and producing useful work? Three separate dimensions:
//
//   transport — did runs succeed, how recently, how fast
//   data      — how much of what it returns matches the profile, and warnings
//   yield     — what its opportunities became (dismissed, pursued, won, jobs)
//
// Observation only. Nothing here feeds opportunity scoring or ranking: early,
// low-volume outcomes would otherwise reinforce whatever happened to win first.

export type SourceHealthStatus = 'HEALTHY' | 'DEGRADED' | 'STALE' | 'FAILING' | 'SKIPPED' | 'UNKNOWN'

export type SourceStateCounters = {
  lastRunAt: Date | null
  lastSuccessAt: Date | null
  lastError: string | null
  lastWarning: string | null
  runCount: number
  successCount: number
  failureCount: number
  skippedCount: number
  warningCount: number
  fetchedTotal: number
  matchedTotal: number
  createdTotal: number
  updatedTotal: number
  lastLatencyMs: number | null
  latencyTotalMs: number
}

export type SourceYield = {
  opportunities: number
  dismissed: number
  /** Pursued, won or lost: a person acted on it. */
  actioned: number
  won: number
  lost: number
  jobsCreated: number
}

export type SourceHealthSnapshot = {
  status: SourceHealthStatus
  summary: string
  transport: {
    runs: number
    successes: number
    failures: number
    successRate: number | null
    hoursSinceSuccess: number | null
    lastLatencyMs: number | null
    avgLatencyMs: number | null
  }
  data: {
    fetched: number
    matched: number
    matchRate: number | null
    /** Matched items that were already stored and unchanged (re-deliveries). */
    unchangedRate: number | null
    warningRate: number | null
    lastWarning: string | null
  }
  yield: SourceYield & {
    dismissalRate: number | null
    actionRate: number | null
    /** Won among resolved won/lost outcomes. */
    winRate: number | null
    resolvedOutcomes: number
  }
}

/** No success for this many sweep intervals makes a source stale. */
export const STALE_AFTER_INTERVALS = 3
/** Below this success rate a source is degraded. */
export const DEGRADED_SUCCESS_RATE = 0.8

const EMPTY_YIELD: SourceYield = { opportunities: 0, dismissed: 0, actioned: 0, won: 0, lost: 0, jobsCreated: 0 }

function rate(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 100) / 100 : null
}

export function sourceHealthSnapshot(
  state: SourceStateCounters | null,
  opts: { now: Date; intervalMs: number; yieldStats?: SourceYield | null },
): SourceHealthSnapshot {
  const y = opts.yieldStats ?? EMPTY_YIELD
  const resolved = y.won + y.lost
  const yieldOut = {
    ...y,
    dismissalRate: rate(y.dismissed, y.opportunities),
    actionRate: rate(y.actioned, y.opportunities),
    winRate: rate(y.won, resolved),
    resolvedOutcomes: resolved,
  }
  const s = state
  const attempted = s ? s.successCount + s.failureCount : 0
  const transport = {
    runs: s?.runCount ?? 0,
    successes: s?.successCount ?? 0,
    failures: s?.failureCount ?? 0,
    successRate: s ? rate(s.successCount, attempted) : null,
    hoursSinceSuccess: s?.lastSuccessAt ? Math.round((opts.now.getTime() - s.lastSuccessAt.getTime()) / 36e5 * 10) / 10 : null,
    lastLatencyMs: s?.lastLatencyMs ?? null,
    avgLatencyMs: s && s.successCount > 0 ? Math.round(s.latencyTotalMs / s.successCount) : null,
  }
  const matchedExisting = s ? Math.max(0, s.matchedTotal - s.createdTotal - s.updatedTotal) : 0
  const data = {
    fetched: s?.fetchedTotal ?? 0,
    matched: s?.matchedTotal ?? 0,
    matchRate: s ? rate(s.matchedTotal, s.fetchedTotal) : null,
    unchangedRate: s ? rate(matchedExisting, s.matchedTotal) : null,
    warningRate: s ? rate(s.warningCount, s.successCount) : null,
    lastWarning: s?.lastWarning ?? null,
  }

  let status: SourceHealthStatus
  let summary: string
  const failingNow = !!s?.lastError && (!s.lastSuccessAt || (s.lastRunAt != null && s.lastRunAt > s.lastSuccessAt))
  if (!s || s.runCount === 0) {
    status = 'UNKNOWN'
    summary = 'No health history yet'
  } else if (attempted === 0) {
    status = 'SKIPPED'
    summary = s.lastWarning ? `Not running: ${s.lastWarning}` : 'Not running'
  } else if (failingNow) {
    status = 'FAILING'
    summary = `Last run failed: ${s.lastError}`
  } else if (!s.lastSuccessAt || opts.now.getTime() - s.lastSuccessAt.getTime() > STALE_AFTER_INTERVALS * opts.intervalMs) {
    status = 'STALE'
    summary = transport.hoursSinceSuccess != null ? `No successful read for ${Math.round(transport.hoursSinceSuccess)} h` : 'No successful read yet'
  } else if ((transport.successRate ?? 1) < DEGRADED_SUCCESS_RATE || s.lastWarning) {
    status = 'DEGRADED'
    summary = s.lastWarning ? `Working with a warning: ${s.lastWarning}` : `Only ${Math.round((transport.successRate ?? 0) * 100)}% of runs succeed`
  } else {
    status = 'HEALTHY'
    summary = `Healthy · ${Math.round((transport.successRate ?? 1) * 100)}% of runs succeed`
  }

  return { status, summary, transport, data, yield: yieldOut }
}
