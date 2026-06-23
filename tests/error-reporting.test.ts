// Tests for the Sentry bootstrap. @sentry/node IS now a dependency (so production
// actually captures errors), loaded via a dynamic import that keeps it optional at
// build time. The "DSN set" path therefore initializes and registers a reporter;
// the "no DSN" / blank-DSN paths remain clean no-ops (the dev/CI default).

import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { initErrorReporting, _resetErrorReportingForTest } from '../packages/backend-core/src/lib/errorReporting.ts'
import { hasErrorReporter, setErrorReporter } from '../packages/backend-core/src/lib/observability.ts'

const savedDsn = process.env.SENTRY_DSN
afterEach(() => {
  if (savedDsn === undefined) delete process.env.SENTRY_DSN
  else process.env.SENTRY_DSN = savedDsn
  setErrorReporter(null)
  _resetErrorReportingForTest()
})

test('no SENTRY_DSN: init is a no-op, no reporter registered', async () => {
  delete process.env.SENTRY_DSN
  await initErrorReporting()
  assert.equal(hasErrorReporter(), false)
})

test('SENTRY_DSN set with SDK installed: initializes and registers a reporter', async () => {
  process.env.SENTRY_DSN = 'https://examplePublicKey@o0.ingest.sentry.io/0'
  // @sentry/node is installed and the DSN is well-formed, so init succeeds and the
  // captureError seam gets a live reporter (no network call is made here).
  await assert.doesNotReject(() => initErrorReporting())
  assert.equal(hasErrorReporter(), true)
})

test('blank SENTRY_DSN is treated as unset', async () => {
  process.env.SENTRY_DSN = '   '
  await initErrorReporting()
  assert.equal(hasErrorReporter(), false)
})
