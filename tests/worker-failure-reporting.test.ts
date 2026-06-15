// Pure-logic tests for the worker's "is this failure a real fault?" decision —
// only retries-exhausted failures are reported to the error transport.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isFinalAttempt } from '../apps/worker/src/lib/failureReporting.ts'

test('a missing job is treated as final (report it)', () => {
  assert.equal(isFinalAttempt(undefined), true)
  assert.equal(isFinalAttempt(null), true)
})

test('default single-attempt job: the first failure is final', () => {
  assert.equal(isFinalAttempt({ attemptsMade: 1 }), true)
})

test('multi-attempt job: earlier attempts are not final (will be retried)', () => {
  assert.equal(isFinalAttempt({ attemptsMade: 1, opts: { attempts: 3 } }), false)
  assert.equal(isFinalAttempt({ attemptsMade: 2, opts: { attempts: 3 } }), false)
})

test('multi-attempt job: the last attempt is final', () => {
  assert.equal(isFinalAttempt({ attemptsMade: 3, opts: { attempts: 3 } }), true)
})

test('attemptsMade beyond the configured attempts is still final', () => {
  assert.equal(isFinalAttempt({ attemptsMade: 5, opts: { attempts: 3 } }), true)
})
