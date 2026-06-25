// Zero-dependency Sentry transport. The @sentry/node SDK drags in a heavy
// OpenTelemetry tree with a moderate advisory that the dependency-review gate
// rejects — so instead we POST directly to Sentry's documented "store" ingestion
// endpoint using built-in fetch. No new dependency; error reporting actually works
// in production when SENTRY_DSN is set (vs. the previous silent no-op).
import { randomBytes } from 'node:crypto'

export type SentryTarget = { ingestUrl: string; publicKey: string }

export type SentryEventOpts = {
  environment?: string
  release?: string
  serverName?: string
}

// Parse a Sentry DSN: {protocol}://{publicKey}@{host}[/{path}]/{projectId}
// Returns the store-endpoint URL + public key, or null if malformed.
export function parseSentryDsn(dsn: string): SentryTarget | null {
  try {
    const u = new URL(dsn)
    const publicKey = u.username
    const segments = u.pathname.split('/').filter(Boolean)
    const projectId = segments.pop()
    if (!publicKey || !projectId) return null
    const pathPrefix = segments.length ? `/${segments.join('/')}` : ''
    return { ingestUrl: `${u.protocol}//${u.host}${pathPrefix}/api/${projectId}/store/`, publicKey }
  } catch {
    return null
  }
}

export type SentryEvent = {
  event_id: string
  timestamp: number
  platform: 'node'
  level: 'error'
  logger: 'acaos'
  environment?: string
  release?: string
  server_name?: string
  exception: { values: Array<{ type: string; value: string }> }
  extra: Record<string, unknown>
}

// Build the event payload. Pure except for event_id (random) and timestamp.
export function buildSentryEvent(err: unknown, context: Record<string, unknown> | undefined, opts: SentryEventOpts = {}): SentryEvent {
  const e = err instanceof Error ? err : new Error(typeof err === 'string' ? err : 'Non-error thrown')
  return {
    event_id: randomBytes(16).toString('hex'),
    timestamp: Math.floor(Date.now() / 1000),
    platform: 'node',
    level: 'error',
    logger: 'acaos',
    environment: opts.environment,
    release: opts.release,
    server_name: opts.serverName,
    exception: { values: [{ type: e.name || 'Error', value: e.message || String(e) }] },
    extra: { ...(context ?? {}), ...(e.stack ? { stack: e.stack } : {}) },
  }
}

// A stable signature for an error, used to dedup a storm of identical errors.
export function errorSignature(err: unknown): string {
  if (err instanceof Error) return `${err.name || 'Error'}:${err.message || ''}`
  return typeof err === 'string' ? err : 'non-error'
}

export type ReportGate = { allow(signature: string, now?: number): boolean }

// Token-bucket + short-window dedup gate for outbound error reports. Without it, an
// error storm (a tight failing loop, a provider outage hammering a code path) turns
// into an equal storm of outbound Sentry POSTs — adding load during the very incident
// it's reporting. `burst` POSTs are allowed immediately, then refilled at
// `ratePerMin`; identical signatures within `dedupMs` collapse to one. Pure aside
// from the injectable clock, so it is fully unit-testable.
export function createReportGate(
  opts: { ratePerMin?: number; burst?: number; dedupMs?: number; now?: () => number } = {},
): ReportGate {
  const ratePerMin = opts.ratePerMin ?? 30
  const burst = opts.burst ?? 10
  const dedupMs = opts.dedupMs ?? 5_000
  const now = opts.now ?? Date.now
  let tokens = burst
  let last = now()
  const recent = new Map<string, number>() // signature -> last-allowed ms

  return {
    allow(signature: string, t: number = now()): boolean {
      // Dedup: an identical error within the window is suppressed outright.
      const seen = recent.get(signature)
      if (seen !== undefined && t - seen < dedupMs) return false
      // Refill the bucket by elapsed time, capped at burst.
      tokens = Math.min(burst, tokens + ((t - last) / 60_000) * ratePerMin)
      last = t
      if (tokens < 1) return false
      tokens -= 1
      recent.set(signature, t)
      // Bound the dedup map so a high-cardinality error stream can't grow it forever.
      if (recent.size > 512) for (const [k, v] of recent) if (t - v >= dedupMs) recent.delete(k)
      return true
    },
  }
}

// Fire-and-forget POST to Sentry. Bounded timeout; NEVER throws — telemetry must
// not break the action it is reporting on.
export async function sendToSentry(target: SentryTarget, err: unknown, context?: Record<string, unknown>, opts: SentryEventOpts = {}): Promise<void> {
  try {
    const event = buildSentryEvent(err, context, opts)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3000)
    try {
      await fetch(target.ingestUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Sentry-Auth': `Sentry sentry_version=7, sentry_client=acaos/1.0, sentry_key=${target.publicKey}`,
        },
        body: JSON.stringify(event),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
  } catch {
    // swallowed — error reporting is best-effort
  }
}
