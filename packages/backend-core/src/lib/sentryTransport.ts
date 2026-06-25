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
