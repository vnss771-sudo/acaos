// DLQ auto-retry policy.
//
// scripts/queue-drain.mjs (Phase 1) is a manual, operator-invoked tool for
// inspecting/retrying/draining a queue's failed-job set. This is the automated
// counterpart: a periodic sweep that gives a FEW bonus retries to failed jobs
// whose error looks transient (a provider blip, a network hiccup) and that
// haven't already exhausted a small bonus-retry budget or gone stale — narrower
// than it might first sound, because BullMQ's own `attempts`/`backoff` (see
// queues.ts's per-queue job opts) already cover the common transient-retry case;
// this only kicks in for jobs that exhausted THOSE and still look transient.
// Anything else (a bad payload, a referenced row that's gone, an auth failure,
// or a job that's already burned its bonus budget) is left in the failed set for
// an operator to triage via queue-drain.mjs.
//
// isTransientError/classifyAutoRetry are pure (unit-tested in isolation from
// BullMQ/Redis, see tests/worker-dlq-auto-retry.test.ts); sweepQueueForAutoRetry
// is the thin wrapper that calls them against a real Queue's failed set
// (tests-redis/dlq-auto-retry.test.ts).

// Checked first — a message matching any of these is NEVER auto-retried
// regardless of the transient list below, since retrying can't fix it: a
// malformed payload (queueSchemas.ts's parseJobPayload marker), a referenced
// row that no longer exists, an auth failure, or a business-policy block (a
// spend/AI-usage quota — retrying doesn't make quota available sooner).
const PERMANENT_PATTERNS: RegExp[] = [
  /QUEUE_PAYLOAD_INVALID/i,
  /not found/i,
  /unauthorized/i,
  /forbidden/i,
  /\b401\b/,
  /\b403\b/,
  /\b404\b/,
  /invalid/i,
  /validation/i,
  /quota/i,
  /disabled/i,
]

// Network/provider-transient signatures: Node's own connection-error codes, HTTP
// 429/5xx-class provider responses, and generic timeout/connection-closed text.
const TRANSIENT_PATTERNS: RegExp[] = [
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ECONNABORTED/i,
  /ETIMEDOUT/i,
  /EAI_AGAIN/i,
  /EPIPE/i,
  /ENOTFOUND/i,
  /socket hang up/i,
  /network/i,
  /fetch failed/i,
  /timed? ?out/i,
  /rate limit/i,
  /too many requests/i,
  /\b429\b/,
  /\b500\b/,
  /\b502\b/,
  /\b503\b/,
  /\b504\b/,
  /internal server error/i,
  /bad gateway/i,
  /service unavailable/i,
  /gateway timeout/i,
  /connection is closed/i,
  /connection terminated/i,
]

/** Pure classifier: does this failure message look worth a bonus retry? */
export function isTransientError(message: string | null | undefined): boolean {
  if (!message) return false
  if (PERMANENT_PATTERNS.some((re) => re.test(message))) return false
  return TRANSIENT_PATTERNS.some((re) => re.test(message))
}

export interface AutoRetryPolicy {
  /** Extra retries granted beyond the job's own configured `attempts`. */
  maxBonusRetries: number
  /** Don't auto-retry a failure that's older than this (ms since it failed). */
  maxAgeMs: number
}

export const DEFAULT_AUTO_RETRY_POLICY: AutoRetryPolicy = {
  maxBonusRetries: 2,
  maxAgeMs: 6 * 60 * 60 * 1000, // 6h
}

export interface FailedJobLike {
  failedReason?: string | null
  attemptsMade: number
  opts?: { attempts?: number }
  finishedOn?: number | null
  timestamp?: number | null
}

export type AutoRetryReason =
  | 'transient-eligible'
  | 'not-transient'
  | 'bonus-retries-exhausted'
  | 'too-old'

export interface AutoRetryDecision {
  retry: boolean
  reason: AutoRetryReason
}

/**
 * Pure eligibility check for one already-failed job. `job.attemptsMade` vs.
 * `job.opts.attempts` is how the bonus-retry budget is tracked: BullMQ's own
 * `job.retry()` (used both here and by queue-drain.mjs) does NOT reset
 * `attemptsMade` unless explicitly asked to, so it keeps counting up across
 * manual and automatic retries alike — `attemptsMade - attempts` is exactly how
 * many retries (of either kind) have already been spent beyond the job's normal
 * budget, so a job an operator already retried several times by hand also
 * correctly stops qualifying here.
 */
export function classifyAutoRetry(
  job: FailedJobLike,
  now: number,
  policy: AutoRetryPolicy = DEFAULT_AUTO_RETRY_POLICY,
): AutoRetryDecision {
  if (!isTransientError(job.failedReason)) return { retry: false, reason: 'not-transient' }

  const configuredAttempts = Math.max(1, job.opts?.attempts ?? 1)
  const bonusUsed = Math.max(0, job.attemptsMade - configuredAttempts)
  if (bonusUsed >= policy.maxBonusRetries) return { retry: false, reason: 'bonus-retries-exhausted' }

  const failedAt = job.finishedOn ?? job.timestamp ?? now
  if (now - failedAt > policy.maxAgeMs) return { retry: false, reason: 'too-old' }

  return { retry: true, reason: 'transient-eligible' }
}

// ── Sweep against a real BullMQ queue ──────────────────────────────────────────

type RetryableJob = FailedJobLike & { id?: string; retry(state?: 'failed'): Promise<void> }
type FailedJobSource = { getFailed(start: number, end: number, asc?: boolean): Promise<RetryableJob[]> }

export interface SweepResult {
  queue: string
  scanned: number
  retried: number
  skipped: number
}

// Bounds how many failed jobs one sweep tick inspects, so a large backlog
// doesn't load an unbounded job list into memory (mirrors queue-drain.mjs's
// own 500-job sampling cap for its list command).
const SWEEP_SAMPLE_LIMIT = 200

export async function sweepQueueForAutoRetry(
  queueName: string,
  queue: FailedJobSource,
  policy: AutoRetryPolicy = DEFAULT_AUTO_RETRY_POLICY,
  now: number = Date.now(),
): Promise<SweepResult> {
  const failed = await queue.getFailed(0, SWEEP_SAMPLE_LIMIT - 1, false)
  let retried = 0
  let skipped = 0
  for (const job of failed) {
    const decision = classifyAutoRetry(job, now, policy)
    if (!decision.retry) {
      skipped += 1
      continue
    }
    try {
      await job.retry('failed')
      retried += 1
    } catch {
      // Lost a race with a concurrent manual retry/drain, or the job aged out of
      // the failed set between listing and acting — skip, not a sweep failure.
      skipped += 1
    }
  }
  return { queue: queueName, scanned: failed.length, retried, skipped }
}

export async function runAutoRetrySweep(
  queueNames: string[],
  getQueue: (name: string) => FailedJobSource,
  policy: AutoRetryPolicy = DEFAULT_AUTO_RETRY_POLICY,
  now: number = Date.now(),
): Promise<SweepResult[]> {
  const results: SweepResult[] = []
  for (const name of queueNames) {
    results.push(await sweepQueueForAutoRetry(name, getQueue(name), policy, now))
  }
  return results
}

// ── Env-driven config ───────────────────────────────────────────────────────────

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

/** Default ON (like isFeatureEnabled) — an operator can opt out if it misbehaves. */
export function isDlqAutoRetryEnabled(): boolean {
  return parseBool(process.env.DLQ_AUTO_RETRY_ENABLED, true)
}

export function dlqAutoRetryIntervalMs(): number {
  return Math.max(60_000, parseIntEnv(process.env.DLQ_AUTO_RETRY_INTERVAL_MS, 5 * 60 * 1000))
}

export function loadAutoRetryPolicyFromEnv(): AutoRetryPolicy {
  return {
    maxBonusRetries: Math.max(0, parseIntEnv(process.env.DLQ_AUTO_RETRY_MAX_BONUS, DEFAULT_AUTO_RETRY_POLICY.maxBonusRetries)),
    maxAgeMs: Math.max(0, parseIntEnv(process.env.DLQ_AUTO_RETRY_MAX_AGE_MS, DEFAULT_AUTO_RETRY_POLICY.maxAgeMs)),
  }
}
