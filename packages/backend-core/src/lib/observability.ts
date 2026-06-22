// Pluggable error-capture seam. The app's error sinks (the Express error
// handler, plus the process unhandledRejection / uncaughtException handlers) all
// route through captureError so a production deployment can register a single
// transport (Sentry, Rollbar, etc.) without touching those call sites.
//
// Dependency-free and a no-op until a reporter is registered, so nothing changes
// in dev/CI where no transport is configured.

export type ErrorContext = Record<string, unknown>
export type ErrorReporter = (err: unknown, context?: ErrorContext) => void

let reporter: ErrorReporter | null = null

/** Register (or clear, with null) the process-wide error transport. */
export function setErrorReporter(fn: ErrorReporter | null): void {
  reporter = fn
}

/** True when a transport is registered — useful for conditional enrichment. */
export function hasErrorReporter(): boolean {
  return reporter !== null
}

// Forward an error to the registered transport. Never throws: a misbehaving
// transport must not turn a handled error into a crash (especially when called
// from the uncaughtException handler, where throwing would be fatal).
export function captureError(err: unknown, context?: ErrorContext): void {
  if (!reporter) return
  try {
    reporter(err, context)
  } catch (transportError) {
    // Last resort — the transport itself failed. Log and move on.
    console.error('[observability] error reporter threw:', transportError)
  }
}

// Pluggable provider-call metric seam. providerClient (in backend-core) records
// every outbound provider call's outcome, but the prometheus registry lives in
// the API process. The API wires its incProviderCall counter in here at startup;
// the worker can wire its own or leave it a no-op. Dependency-free and a no-op
// until registered, so backend-core never imports the API's metrics module.
export type ProviderCallObserver = (provider: string, operation: string, outcome: string) => void

let providerCallObserver: ProviderCallObserver | null = null

export function setProviderCallObserver(fn: ProviderCallObserver | null): void {
  providerCallObserver = fn
}

export function recordProviderCall(provider: string, operation: string, outcome: string): void {
  if (!providerCallObserver) return
  try {
    providerCallObserver(provider, operation, outcome)
  } catch (observerError) {
    console.error('[observability] provider-call observer threw:', observerError)
  }
}
