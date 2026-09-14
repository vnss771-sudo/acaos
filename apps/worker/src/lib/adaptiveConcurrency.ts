// Queue-depth-adaptive worker concurrency.
//
// Each BullMQ Worker in worker.ts is created with a fixed `concurrency` — static
// even though load isn't: a burst of queued jobs sits waiting while the process
// has headroom, and a quiet period holds concurrency slots that do nothing (which
// matters when concurrency also gates a shared external rate limit, e.g. OpenAI
// calls on research-lead/generate-outreach/analyze-reply).
//
// This scales a worker's concurrency toward a configured max when its queue's
// waiting-job count is high, and toward a configured min when it's near zero,
// with hysteresis (nextAdaptiveState requires `confirmTicks` consecutive polls to
// agree before acting) so a bursty-but-not-really-backed-up queue doesn't thrash.
// Opt-in via WORKER_ADAPTIVE_CONCURRENCY_ENABLED — unset or false leaves every
// worker's concurrency exactly as hardcoded in worker.ts, unchanged from today.
//
// nextAdaptiveState is pure (unit-tested in isolation from BullMQ/Redis, see
// tests/worker-adaptive-concurrency.test.ts); createAdaptiveScaler is the thin
// stateful wrapper that polls a real Queue and applies decisions to a real Worker
// (tests-redis/adaptive-concurrency.test.ts).

export interface AdaptiveConcurrencyConfig {
  min: number
  max: number
  /** Waiting-job count at/above which a scale-up is considered. */
  scaleUpAt: number
  /** Waiting-job count at/below which a scale-down is considered. */
  scaleDownAt: number
  /** How much to change concurrency by per applied decision. */
  step: number
  /** Consecutive polls the signal must hold before a change is applied. */
  confirmTicks: number
}

export interface AdaptiveState {
  concurrency: number
  /** Consecutive polls that agreed on `pending`; 0 when there's no pending direction. */
  streak: number
  pending: 'up' | 'down' | null
}

export type ScaleAction = 'scale-up' | 'scale-down' | 'hold'

export interface AdaptiveDecision {
  state: AdaptiveState
  action: ScaleAction
}

export function initialAdaptiveState(startConcurrency: number): AdaptiveState {
  return { concurrency: Math.max(1, Math.round(startConcurrency)), streak: 0, pending: null }
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

/**
 * Pure scaling-decision step. Given the current state and a fresh waiting-job
 * observation, returns the next state and what it did. Concurrency is always
 * clamped to [max(1, min), max] — never below 1 even if `min` is misconfigured
 * below that, and never above `max`.
 */
export function nextAdaptiveState(
  state: AdaptiveState,
  waitingCount: number,
  config: AdaptiveConcurrencyConfig,
): AdaptiveDecision {
  const min = Math.max(1, Math.min(config.min, config.max))
  const max = Math.max(min, config.max)
  const current = clamp(state.concurrency, min, max)

  const wantsUp = waitingCount >= config.scaleUpAt && current < max
  const wantsDown = waitingCount <= config.scaleDownAt && current > min
  // Both can't be true at once for a sane config (scaleUpAt > scaleDownAt), but if
  // they were, prefer scaling up — a false idle read is cheaper to correct than a
  // false-backlog read (which just wastes concurrency, not correctness).
  const direction: 'up' | 'down' | null = wantsUp ? 'up' : wantsDown ? 'down' : null

  if (!direction) {
    return { state: { concurrency: current, streak: 0, pending: null }, action: 'hold' }
  }

  const streak = state.pending === direction ? state.streak + 1 : 1
  const confirmTicks = Math.max(1, config.confirmTicks)

  if (streak < confirmTicks) {
    return { state: { concurrency: current, streak, pending: direction }, action: 'hold' }
  }

  const step = Math.max(1, config.step)
  const nextConcurrency = clamp(direction === 'up' ? current + step : current - step, min, max)
  return {
    state: { concurrency: nextConcurrency, streak: 0, pending: null },
    action: nextConcurrency === current ? 'hold' : direction === 'up' ? 'scale-up' : 'scale-down',
  }
}

// ── Stateful wrapper around a real BullMQ Worker/Queue ────────────────────────

type ConcurrencyMutableWorker = { concurrency: number }
type WaitingCountQueue = { getJobCounts(...states: string[]): Promise<Record<string, number>> }

export interface AdaptiveScalerEvent {
  queue: string
  from: number
  to: number
  action: ScaleAction
  waiting: number
}

export interface AdaptiveScalerOptions {
  pollIntervalMs: number
  config: AdaptiveConcurrencyConfig
  onChange?: (event: AdaptiveScalerEvent) => void
  onError?: (err: unknown) => void
}

export interface AdaptiveScaler {
  stop(): void
}

/**
 * Polls `queue`'s waiting-job count on an interval and adjusts `worker.concurrency`
 * accordingly. Setting `Worker#concurrency` only changes how many NEW jobs the
 * worker claims going forward — BullMQ's internal fetch loop compares the number
 * of jobs currently being processed against `_concurrency` live, so an in-flight
 * job that was already claimed under a higher concurrency always runs to
 * completion; a scale-down never aborts or abandons it.
 */
export function createAdaptiveScaler(
  queueName: string,
  queue: WaitingCountQueue,
  worker: ConcurrencyMutableWorker,
  opts: AdaptiveScalerOptions,
): AdaptiveScaler {
  let state = initialAdaptiveState(worker.concurrency)
  let stopped = false
  let inFlight = false

  const tick = async () => {
    if (stopped || inFlight) return
    inFlight = true
    try {
      const counts = await queue.getJobCounts('waiting')
      const waiting = counts.waiting ?? 0
      const decision = nextAdaptiveState(state, waiting, opts.config)
      const from = state.concurrency
      state = decision.state
      if (decision.action !== 'hold' && state.concurrency !== from) {
        worker.concurrency = state.concurrency
        opts.onChange?.({ queue: queueName, from, to: state.concurrency, action: decision.action, waiting })
      }
    } catch (err) {
      opts.onError?.(err)
    } finally {
      inFlight = false
    }
  }

  const interval = setInterval(() => { void tick() }, Math.max(1000, opts.pollIntervalMs))
  interval.unref?.()

  return {
    stop() {
      stopped = true
      clearInterval(interval)
    },
  }
}

// ── Env-driven config, one knob set shared by all adaptive-enabled queues plus
// optional per-queue min/max overrides ─────────────────────────────────────────

function parseBool(raw: string | undefined, dflt: boolean): boolean {
  if (raw === undefined) return dflt
  const s = raw.trim().toLowerCase()
  if (s === '') return dflt
  if (s === 'true' || s === '1' || s === 'on' || s === 'yes') return true
  if (s === 'false' || s === '0' || s === 'off' || s === 'no') return false
  return dflt
}

function parseIntEnv(raw: string | undefined, dflt: number): number {
  if (raw === undefined || raw.trim() === '') return dflt
  const n = Number(raw)
  return Number.isFinite(n) ? n : dflt
}

function envKey(queueName: string): string {
  return queueName.toUpperCase().replace(/-/g, '_')
}

export function isAdaptiveConcurrencyEnabled(): boolean {
  return parseBool(process.env.WORKER_ADAPTIVE_CONCURRENCY_ENABLED, false)
}

export function adaptivePollIntervalMs(): number {
  return Math.max(1000, parseIntEnv(process.env.WORKER_ADAPTIVE_POLL_INTERVAL_MS, 15_000))
}

/**
 * Builds the per-queue adaptive config. `staticConcurrency` (the value already
 * hardcoded for this queue in worker.ts) is the default `max`, so enabling the
 * feature with no further env overrides scales between 1 and today's fixed value
 * — never above it — and a queue whose static concurrency is already 1 has no
 * room to scale at all (min === max), matching its current behavior exactly.
 */
export function loadAdaptiveConfigFromEnv(queueName: string, staticConcurrency: number): AdaptiveConcurrencyConfig {
  const key = envKey(queueName)
  const max = Math.max(1, parseIntEnv(process.env[`WORKER_ADAPTIVE_MAX_${key}`], staticConcurrency))
  const globalMin = Math.max(1, parseIntEnv(process.env.WORKER_ADAPTIVE_MIN_CONCURRENCY, 1))
  const min = Math.max(1, Math.min(max, parseIntEnv(process.env[`WORKER_ADAPTIVE_MIN_${key}`], globalMin)))
  return {
    min,
    max,
    scaleUpAt: Math.max(1, parseIntEnv(process.env.WORKER_ADAPTIVE_SCALE_UP_AT, max)),
    scaleDownAt: Math.max(0, parseIntEnv(process.env.WORKER_ADAPTIVE_SCALE_DOWN_AT, 0)),
    step: Math.max(1, parseIntEnv(process.env.WORKER_ADAPTIVE_STEP, 1)),
    confirmTicks: Math.max(1, parseIntEnv(process.env.WORKER_ADAPTIVE_CONFIRM_TICKS, 2)),
  }
}
