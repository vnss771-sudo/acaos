import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { timingSafeBearerMatch, readinessDetailAllowed } from '../apps/api/src/lib/readiness.ts'

// The readiness detail gate decides whether the health/readiness endpoints expose
// operational detail (dependency state, config gaps, env, commit) or only the
// public boolean. Getting this wrong either leaks deployment recon to the internet
// or hides diagnostics from ops, so pin every branch.

const SAVED = { ...process.env }
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k]
  Object.assign(process.env, SAVED)
})

function set(env: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

const bearer = (t: string) => `Bearer ${t}`

// --- timingSafeBearerMatch ---

test('timingSafeBearerMatch accepts the exact "Bearer <token>" and rejects everything else', () => {
  assert.equal(timingSafeBearerMatch(bearer('s3cret'), 's3cret'), true)
  assert.equal(timingSafeBearerMatch(bearer('wrong'), 's3cret'), false)
  assert.equal(timingSafeBearerMatch('s3cret', 's3cret'), false, 'missing Bearer prefix')
  assert.equal(timingSafeBearerMatch(undefined, 's3cret'), false)
  assert.equal(timingSafeBearerMatch('', 's3cret'), false)
})

test('timingSafeBearerMatch compares fixed-length digests (no length-based throw on mismatch)', () => {
  // A very long header must not throw (timingSafeEqual would on raw unequal lengths);
  // hashing both sides keeps it a constant-length comparison.
  const long = 'Bearer ' + 'a'.repeat(10_000)
  assert.doesNotThrow(() => timingSafeBearerMatch(long, 's3cret'))
  assert.equal(timingSafeBearerMatch(long, 's3cret'), false)
  // Sanity: the digest of the matching header equals the expected digest.
  const same = createHash('sha256').update(bearer('tok')).digest()
  const exp = createHash('sha256').update('Bearer tok').digest()
  assert.deepEqual(same, exp)
})

// --- readinessDetailAllowed ---

test('READINESS_TOKEN configured: detail only with the matching bearer token', () => {
  set({ NODE_ENV: 'production', READINESS_TOKEN: 'rt-123', METRICS_TOKEN: undefined })
  assert.equal(readinessDetailAllowed(bearer('rt-123')), true)
  assert.equal(readinessDetailAllowed(bearer('nope')), false)
  assert.equal(readinessDetailAllowed(undefined), false)
})

test('METRICS_TOKEN is accepted as a fallback when READINESS_TOKEN is unset', () => {
  set({ NODE_ENV: 'production', READINESS_TOKEN: undefined, METRICS_TOKEN: 'mt-456' })
  assert.equal(readinessDetailAllowed(bearer('mt-456')), true)
  assert.equal(readinessDetailAllowed(bearer('mt-wrong')), false)
})

test('READINESS_TOKEN takes precedence over METRICS_TOKEN when both are set', () => {
  set({ NODE_ENV: 'production', READINESS_TOKEN: 'rt', METRICS_TOKEN: 'mt' })
  assert.equal(readinessDetailAllowed(bearer('rt')), true)
  assert.equal(readinessDetailAllowed(bearer('mt')), false, 'the fallback must not be honored once READINESS_TOKEN is set')
})

test('no token configured in production: detail fails closed', () => {
  set({ NODE_ENV: 'production', READINESS_TOKEN: undefined, METRICS_TOKEN: undefined })
  assert.equal(readinessDetailAllowed(undefined), false)
  assert.equal(readinessDetailAllowed(bearer('anything')), false)
})

test('no token configured outside production: detail is open (dev/test convenience)', () => {
  set({ NODE_ENV: 'development', READINESS_TOKEN: undefined, METRICS_TOKEN: undefined })
  assert.equal(readinessDetailAllowed(undefined), true)
})
