// Tests for the Sentry bootstrap. Error reporting now uses a zero-dependency HTTP
// transport (sentryTransport.ts) — so a well-formed SENTRY_DSN actually registers a
// live reporter (no SDK needed, no network call at init). No DSN / blank / malformed
// DSN stay clean no-ops.

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

test('well-formed SENTRY_DSN: registers a live reporter (no network at init)', async () => {
  process.env.SENTRY_DSN = 'https://examplePublicKey@o0.ingest.sentry.io/0'
  await assert.doesNotReject(() => initErrorReporting())
  assert.equal(hasErrorReporter(), true)
})

test('malformed SENTRY_DSN: warns and stays a no-op', async () => {
  process.env.SENTRY_DSN = 'not-a-valid-dsn'
  await assert.doesNotReject(() => initErrorReporting())
  assert.equal(hasErrorReporter(), false)
})

test('blank SENTRY_DSN is treated as unset', async () => {
  process.env.SENTRY_DSN = '   '
  await initErrorReporting()
  assert.equal(hasErrorReporter(), false)
})
