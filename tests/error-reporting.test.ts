// Tests for the OPTIONAL Sentry bootstrap. @sentry/node is intentionally NOT a
// vendored dependency (it drags in a heavy, recurringly-vuln OpenTelemetry tree),
// and it isn't needed for errors to be captured — every captureError call site
// already logs the error via the structured logger first. An operator who wants
// Sentry *aggregation* installs @sentry/node in their deployment and sets
// SENTRY_DSN; the dynamic import then wires it up. With the SDK absent (the repo's
// default), the "DSN set" path degrades gracefully (warn + stay a no-op) and the
// "no DSN" path is the clean default.

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
  // @sentry/node is not vendored, so the dynamic import rejects and is caught —
  // errors still reach the structured logs at each captureError call site.
  await assert.doesNotReject(() => initErrorReporting())
  assert.equal(hasErrorReporter(), false)
})

test('blank SENTRY_DSN is treated as unset', async () => {
  process.env.SENTRY_DSN = '   '
  await initErrorReporting()
  assert.equal(hasErrorReporter(), false)
})
