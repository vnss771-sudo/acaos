// Browser error reporting to Sentry, with no SDK dependency — the same approach
// as the backend's packages/backend-core/src/lib/sentryTransport.ts. Active only
// when VITE_SENTRY_DSN is set at build time; otherwise every export is a no-op.
//
// Events go to Sentry's "store" endpoint with the key in the query string and a
// text/plain body, so the browser sends a simple CORS request (no preflight).
// The CSP's `connect-src https:` already allows the Sentry ingest host.

export type SentryTarget = { ingestUrl: string }

export function parseSentryDsn(dsn: string | undefined): SentryTarget | null {
  if (!dsn?.trim()) return null
  try {
    const u = new URL(dsn.trim())
    const publicKey = u.username
    const segments = u.pathname.split('/').filter(Boolean)
    const projectId = segments.pop()
    if (!publicKey || !projectId || u.protocol !== 'https:') return null
    const pathPrefix = segments.length ? `/${segments.join('/')}` : ''
    const query = new URLSearchParams({ sentry_version: '7', sentry_client: 'acaos-web/1.0', sentry_key: publicKey })
    return { ingestUrl: `${u.protocol}//${u.host}${pathPrefix}/api/${projectId}/store/?${query}` }
  } catch {
    return null
  }
}

export type BrowserSentryEvent = {
  event_id: string
  timestamp: number
  platform: 'javascript'
  level: 'error'
  logger: 'acaos-web'
  environment?: string
  release?: string
  request?: { url: string }
  exception: { values: Array<{ type: string; value: string }> }
  extra: Record<string, unknown>
}

// Query strings and fragments can carry one-time tokens (password reset,
// mailbox OAuth callbacks), so only the origin and path are reported.
function pageUrl(): string | undefined {
  if (typeof window === 'undefined') return undefined
  return `${window.location.origin}${window.location.pathname}`
}

function eventId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function buildBrowserEvent(
  err: unknown,
  context: Record<string, unknown> | undefined,
  opts: { environment?: string; release?: string } = {},
): BrowserSentryEvent {
  const e = err instanceof Error ? err : new Error(typeof err === 'string' ? err : 'Non-error thrown')
  const url = pageUrl()
  return {
    event_id: eventId(),
    timestamp: Math.floor(Date.now() / 1000),
    platform: 'javascript',
    level: 'error',
    logger: 'acaos-web',
    environment: opts.environment,
    release: opts.release,
    ...(url ? { request: { url } } : {}),
    exception: { values: [{ type: e.name || 'Error', value: e.message || String(e) }] },
    extra: { ...(context ?? {}), ...(e.stack ? { stack: e.stack } : {}) },
  }
}

// A render loop or a failing poll can throw the same error many times a
// second. Identical errors are reported once per page load, and the page
// reports at most `max` distinct errors.
export function createBrowserReportGate(max = 20): { allow(signature: string): boolean } {
  const seen = new Set<string>()
  return {
    allow(signature: string) {
      if (seen.has(signature) || seen.size >= max) return false
      seen.add(signature)
      return true
    },
  }
}

function signature(err: unknown): string {
  if (err instanceof Error) return `${err.name || 'Error'}:${err.message || ''}`
  return typeof err === 'string' ? err : 'non-error'
}

const target = parseSentryDsn(import.meta.env.VITE_SENTRY_DSN)
const environment = import.meta.env.VITE_SENTRY_ENVIRONMENT || import.meta.env.MODE
const release = import.meta.env.VITE_RELEASE_SHA || undefined
const gate = createBrowserReportGate()

export function isErrorReportingEnabled(): boolean {
  return target !== null
}

// Fire-and-forget. Never throws: reporting must not break the page it reports on.
export function reportError(err: unknown, context?: Record<string, unknown>): void {
  if (!target || !gate.allow(signature(err))) return
  try {
    const event = buildBrowserEvent(err, context, { environment, release })
    void fetch(target.ingestUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify(event),
      keepalive: true,
      credentials: 'omit',
    }).catch(() => {})
  } catch {
    // ignore
  }
}

let installed = false

// Uncaught errors and unhandled promise rejections. Render errors are caught by
// ErrorBoundary, which reports them itself.
export function installGlobalErrorHandlers(): void {
  if (installed || !target || typeof window === 'undefined') return
  installed = true
  window.addEventListener('error', (event) => {
    reportError(event.error ?? event.message, { source: 'window.onerror' })
  })
  window.addEventListener('unhandledrejection', (event) => {
    reportError(event.reason, { source: 'unhandledrejection' })
  })
}
