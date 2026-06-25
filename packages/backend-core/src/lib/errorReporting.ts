// Error-transport bootstrap. Wires the captureError seam (observability.ts) to
// Sentry when SENTRY_DSN is set, via a zero-dependency HTTP transport (see
// sentryTransport.ts) — so production error reporting actually works without
// pulling in the @sentry/node SDK (whose OpenTelemetry tree trips the
// dependency-review gate). With no DSN this is a clean no-op.
import { setErrorReporter } from './observability.js'
import { logger } from './logger.js'
import { parseSentryDsn, sendToSentry } from './sentryTransport.js'

let initialized = false

export async function initErrorReporting(): Promise<void> {
  if (initialized) return
  const dsn = process.env.SENTRY_DSN?.trim()
  if (!dsn) return // no transport configured

  const target = parseSentryDsn(dsn)
  if (!target) {
    logger.warn('SENTRY_DSN is set but malformed — error reporting disabled')
    return
  }

  const opts = {
    environment: process.env.NODE_ENV ?? 'development',
    release: process.env.npm_package_version,
    serverName: process.env.HOSTNAME,
  }
  setErrorReporter((err: unknown, context?: Record<string, unknown>) => {
    void sendToSentry(target, err, context, opts)
  })
  initialized = true
  logger.info('error reporting initialized', { transport: 'sentry-http' })
}

/** Test-only: allow re-running init in a fresh state. */
export function _resetErrorReportingForTest(): void {
  initialized = false
}
