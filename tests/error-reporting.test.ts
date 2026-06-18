// Tests for the optional Sentry bootstrap. @sentry/node is intentionally NOT a
// dependency, so the "DSN set" path exercises the graceful-degradation branch
// (SDK absent -> warn + stay no-op), and the "no DSN" path is the dev/CI default.

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

test('SENTRY_DSN set but SDK absent: degrades gracefully (no throw, no reporter)', async () => {
  process.env.SENTRY_DSN = 'https://examplePublicKey@o0.ingest.sentry.io/0'
  // @sentry/node is not installed, so the dynamic import rejects and is caught.
  await assert.doesNotReject(() => initErrorReporting())
  assert.equal(hasErrorReporter(), false)
})

test('blank SENTRY_DSN is treated as unset', async () => {
  process.env.SENTRY_DSN = '   '
  await initErrorReporting()
  assert.equal(hasErrorReporter(), false)
})
