import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getRuntimeMetadata, getBuildInfoLabels, getProcessStartTimeSeconds } from '../packages/backend-core/src/lib/release.ts'

test('runtime metadata includes canonical releaseId', () => {
  const metadata = getRuntimeMetadata('acaos-api')
  assert.equal(metadata.service, 'acaos-api')
  assert.ok(metadata.releaseId)
  assert.ok(metadata.version)
})

test('build info labels include service and release_id', () => {
  const labels = getBuildInfoLabels('acaos-worker')
  assert.equal(labels.service, 'acaos-worker')
  assert.ok(labels.release_id)
})

test('process start time is a unix timestamp', () => {
  assert.equal(Number.isInteger(getProcessStartTimeSeconds()), true)
  assert.ok(getProcessStartTimeSeconds() > 0)
})

// Release-identity resolution: a Railway deploy sets no ACAOS_RELEASE_*/GITHUB_SHA,
// so without the platform fallback the running build reports commit:null and is
// untraceable. These pin the precedence.
const RELEASE_KEYS = ['ACAOS_RELEASE_SHA', 'GITHUB_SHA', 'ACAOS_RELEASE_ID', 'RAILWAY_GIT_COMMIT_SHA'] as const
function withEnv(overrides: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {}
  for (const k of RELEASE_KEYS) saved[k] = process.env[k]
  try {
    for (const k of RELEASE_KEYS) delete process.env[k]
    for (const [k, v] of Object.entries(overrides)) { if (v !== undefined) process.env[k] = v }
    fn()
  } finally {
    for (const k of RELEASE_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]! }
  }
}

test("commit falls back to Railway's built-in deploy SHA when nothing else is stamped", () => {
  withEnv({ RAILWAY_GIT_COMMIT_SHA: 'abcdef1234567890face' }, () => {
    const m = getRuntimeMetadata('acaos-api')
    assert.equal(m.commit, 'abcdef1234567890face')
    assert.ok(m.releaseId.includes('abcdef123456'), `releaseId should embed the short SHA, got ${m.releaseId}`)
  })
})

test('an explicit ACAOS_RELEASE_SHA takes precedence over the Railway SHA', () => {
  withEnv({ ACAOS_RELEASE_SHA: 'deadbeefcafe0000', RAILWAY_GIT_COMMIT_SHA: 'ignored0000' }, () => {
    assert.equal(getRuntimeMetadata('acaos-api').commit, 'deadbeefcafe0000')
  })
})
