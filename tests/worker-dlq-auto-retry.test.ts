// Pure-logic tests for the DLQ auto-retry classifier — isolated from BullMQ/Redis
// (see tests-redis/dlq-auto-retry.test.ts for the live-Redis integration tier
// that seeds real failed jobs and runs the sweep against them).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isTransientError,
  classifyAutoRetry,
  DEFAULT_AUTO_RETRY_POLICY,
  type FailedJobLike,
} from '../apps/worker/src/lib/dlqAutoRetry.ts'

test('isTransientError: recognizes network-class error codes/messages', () => {
  assert.equal(isTransientError('connect ECONNREFUSED 127.0.0.1:443'), true)
  assert.equal(isTransientError('read ECONNRESET'), true)
  assert.equal(isTransientError('Error: socket hang up'), true)
  assert.equal(isTransientError('request to https://api.openai.com failed, reason: getaddrinfo EAI_AGAIN'), true)
  assert.equal(isTransientError('fetch failed'), true)
})

test('isTransientError: recognizes provider rate-limit/5xx-class responses', () => {
  assert.equal(isTransientError('Request failed with status code 429'), true)
  assert.equal(isTransientError('OpenAI rate limit exceeded, please retry'), true)
  assert.equal(isTransientError('502 Bad Gateway'), true)
  assert.equal(isTransientError('upstream connect error: 503 Service Unavailable'), true)
})

test('isTransientError: a plain timeout message counts as transient', () => {
  assert.equal(isTransientError('Request timed out after 30000ms'), true)
  assert.equal(isTransientError('connection timeout'), true)
})

test('isTransientError: permanent-looking failures are never transient, even if they mention a network term', () => {
  assert.equal(isTransientError('QUEUE_PAYLOAD_INVALID: research-lead (leadId: Required)'), false)
  assert.equal(isTransientError('Prospect abc123 not found'), false)
  assert.equal(isTransientError('Unauthorized: invalid API key'), false)
  assert.equal(isTransientError('AI usage quota exceeded for workspace'), false)
  assert.equal(isTransientError('FEATURE_AI disabled'), false)
})

test('isTransientError: an unrecognized/unknown error is conservatively NOT auto-retried', () => {
  assert.equal(isTransientError('Something bizarre happened'), false)
  assert.equal(isTransientError(''), false)
  assert.equal(isTransientError(null), false)
  assert.equal(isTransientError(undefined), false)
})

function job(overrides: Partial<FailedJobLike> = {}): FailedJobLike {
  return {
    failedReason: 'ECONNRESET',
    attemptsMade: 3,
    opts: { attempts: 3 },
    finishedOn: Date.now(),
    timestamp: Date.now() - 1000,
    ...overrides,
  }
}

test('classifyAutoRetry: a fresh, exhausted, transient failure is eligible', () => {
  const d = classifyAutoRetry(job(), Date.now())
  assert.equal(d.retry, true)
  assert.equal(d.reason, 'transient-eligible')
})

test('classifyAutoRetry: a non-transient failure is never retried regardless of age/attempts', () => {
  const d = classifyAutoRetry(job({ failedReason: 'QUEUE_PAYLOAD_INVALID: bad payload' }), Date.now())
  assert.equal(d.retry, false)
  assert.equal(d.reason, 'not-transient')
})

test('classifyAutoRetry: exhausts after maxBonusRetries — attemptsMade tracks BOTH manual and auto retries', () => {
  const policy = { ...DEFAULT_AUTO_RETRY_POLICY, maxBonusRetries: 2 }
  const now = Date.now()
  // attempts=3 configured; attemptsMade=3 -> 0 bonus used yet -> eligible
  assert.equal(classifyAutoRetry(job({ attemptsMade: 3 }), now, policy).retry, true)
  // attemptsMade=4 -> 1 bonus used -> still under the ceiling of 2 -> eligible
  assert.equal(classifyAutoRetry(job({ attemptsMade: 4 }), now, policy).retry, true)
  // attemptsMade=5 -> 2 bonus used -> AT the ceiling -> no longer eligible
  const atCeiling = classifyAutoRetry(job({ attemptsMade: 5 }), now, policy)
  assert.equal(atCeiling.retry, false)
  assert.equal(atCeiling.reason, 'bonus-retries-exhausted')
})

test('classifyAutoRetry: a failure older than maxAgeMs is left for an operator', () => {
  const now = Date.now()
  const policy = { ...DEFAULT_AUTO_RETRY_POLICY, maxAgeMs: 60_000 }
  const stale = job({ finishedOn: now - 120_000 })
  const d = classifyAutoRetry(stale, now, policy)
  assert.equal(d.retry, false)
  assert.equal(d.reason, 'too-old')
})

test('classifyAutoRetry: falls back to job.timestamp when finishedOn is absent', () => {
  const now = Date.now()
  const policy = { ...DEFAULT_AUTO_RETRY_POLICY, maxAgeMs: 60_000 }
  const d = classifyAutoRetry(job({ finishedOn: null, timestamp: now - 120_000 }), now, policy)
  assert.equal(d.retry, false)
  assert.equal(d.reason, 'too-old')
})

test('classifyAutoRetry: missing opts.attempts defaults to 1 configured attempt', () => {
  const d = classifyAutoRetry(job({ opts: undefined, attemptsMade: 1 }), Date.now())
  assert.equal(d.retry, true, '0 bonus used (1 attemptsMade - 1 default configured)')
})
