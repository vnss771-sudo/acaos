// Optional error-transport bootstrap. Wires the captureError seam (observability.ts)
// to Sentry when SENTRY_DSN is set. @sentry/node is an OPTIONAL dependency: it's
// loaded via a dynamic import with a non-literal specifier so the build never
// requires it. With no DSN (or no SDK installed) this is a clean no-op and
// captureError stays inert — exactly the dev/CI behavior.
import { setErrorReporter } from './observability.js'
import { logger } from './logger.js'

let initialized = false

export async function initErrorReporting(): Promise<void> {
  if (initialized) return
  const dsn = process.env.SENTRY_DSN?.trim()
  if (!dsn) return // no transport configured

  try {
    // Non-literal specifier: TypeScript won't resolve (or require) the module at
    // build time, so @sentry/node stays optional. Result is typed loosely.
    const specifier = '@sentry/node'
    const Sentry = await import(specifier)
    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV ?? 'development',
      release: process.env.npm_package_version,
      tracesSampleRate: 0, // error reporting only; no perf tracing by default
    })
    setErrorReporter((err: unknown, context?: Record<string, unknown>) => {
      Sentry.captureException(err, context ? { extra: context } : undefined)
    })
    initialized = true
    logger.info('error reporting initialized', { transport: 'sentry' })
  } catch (e) {
    // DSN was set but the SDK isn't installed (or failed to init). Don't crash
    // startup over telemetry — log and continue with reporting disabled.
    logger.warn('SENTRY_DSN is set but @sentry/node could not be loaded; error reporting disabled', {
      err: e instanceof Error ? e.message : String(e),
    })
  }
}

/** Test-only: allow re-running init in a fresh state. */
export function _resetErrorReportingForTest(): void {
  initialized = false
}
