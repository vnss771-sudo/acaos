// Tests for the pluggable error-capture seam and its wiring into the Express
// error handler. Pure-logic: no services.

import { test, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { setErrorReporter, hasErrorReporter, captureError } from '../apps/api/src/lib/observability.ts'
import { ApiError, errorHandler } from '../apps/api/src/lib/http.ts'
import type { Request, Response, NextFunction } from 'express'

afterEach(() => setErrorReporter(null))

test('captureError is a no-op (and never throws) with no reporter registered', () => {
  assert.equal(hasErrorReporter(), false)
  assert.doesNotThrow(() => captureError(new Error('nobody listening')))
})

test('setErrorReporter registers a transport that receives the error and context', () => {
  const reporter = mock.fn()
  setErrorReporter(reporter)
  assert.equal(hasErrorReporter(), true)

  const err = new Error('boom')
  captureError(err, { path: '/x' })
  assert.equal(reporter.mock.callCount(), 1)
  assert.equal(reporter.mock.calls[0].arguments[0], err)
  assert.deepEqual(reporter.mock.calls[0].arguments[1], { path: '/x' })
})

test('setErrorReporter(null) clears the transport', () => {
  const reporter = mock.fn()
  setErrorReporter(reporter)
  setErrorReporter(null)
  captureError(new Error('after clear'))
  assert.equal(reporter.mock.callCount(), 0)
  assert.equal(hasErrorReporter(), false)
})

test('captureError swallows a throwing transport (must not crash the caller)', () => {
  setErrorReporter(() => { throw new Error('transport down') })
  assert.doesNotThrow(() => captureError(new Error('original')))
})

// --- error handler wiring -------------------------------------------------

function runErrorHandler(error: unknown) {
  const json = mock.fn()
  const status = mock.fn(() => ({ json }))
  const res = { status } as unknown as Response
  const req = { originalUrl: '/api/thing', method: 'POST', id: 'req-1' } as unknown as Request
  errorHandler(error, req, res, (() => {}) as NextFunction)
}

test('errorHandler forwards an unexpected error to the reporter with request context', () => {
  const reporter = mock.fn()
  setErrorReporter(reporter)
  const err = new Error('db exploded')
  runErrorHandler(err)
  assert.equal(reporter.mock.callCount(), 1)
  assert.equal(reporter.mock.calls[0].arguments[0], err)
  assert.deepEqual(reporter.mock.calls[0].arguments[1], { path: '/api/thing', method: 'POST', requestId: 'req-1' })
})

test('errorHandler does NOT report expected ApiError (4xx) to the transport', () => {
  const reporter = mock.fn()
  setErrorReporter(reporter)
  runErrorHandler(new ApiError(404, 'Not found'))
  assert.equal(reporter.mock.callCount(), 0)
})
