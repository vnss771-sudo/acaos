// Unit tests for the ingest API-key → workspace cache, including the eviction
// path that key rotation/deletion relies on to invalidate a revoked key.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  getCachedWorkspace,
  setCachedWorkspace,
  evictCachedWorkspace,
  attachIngestCacheInvalidator,
} from '../apps/api/src/lib/ingestCache.ts'
import type { IngestCacheInvalidator } from '../apps/api/src/lib/ingestCacheInvalidation.ts'

test('set then get returns the cached workspace', () => {
  setCachedWorkspace('hash-a', { id: 'ws-a', plan: 'free' })
  assert.deepEqual(getCachedWorkspace('hash-a'), { id: 'ws-a', plan: 'free' })
})

test('evict removes the entry so a revoked key no longer resolves', () => {
  setCachedWorkspace('hash-b', { id: 'ws-b', plan: 'starter' })
  assert.ok(getCachedWorkspace('hash-b'))
  evictCachedWorkspace('hash-b')
  assert.equal(getCachedWorkspace('hash-b'), null)
})

test('an unknown hash returns null', () => {
  assert.equal(getCachedWorkspace('never-set'), null)
})

test('evicting an absent hash is a harmless no-op', () => {
  assert.doesNotThrow(() => evictCachedWorkspace('not-present'))
})

test('evictCachedWorkspace notifies the attached invalidator, and a cross-pod message evicts locally', () => {
  const published: string[] = []
  let onInvalidate: ((hash: string) => void) | undefined
  const fakeInvalidator: IngestCacheInvalidator = {
    async publish(hash) { published.push(hash) },
    async subscribe(cb) { onInvalidate = cb },
  }
  attachIngestCacheInvalidator(fakeInvalidator)

  // Local eviction (e.g. this pod handling a key rotation) broadcasts.
  setCachedWorkspace('hash-invalidator', { id: 'ws-inv', plan: 'pro' })
  evictCachedWorkspace('hash-invalidator')
  assert.deepEqual(published, ['hash-invalidator'])

  // A message "from a sibling pod" (simulated via the subscribed callback)
  // evicts this pod's entry too, without a local evictCachedWorkspace call.
  setCachedWorkspace('hash-sibling', { id: 'ws-sib', plan: 'free' })
  assert.ok(getCachedWorkspace('hash-sibling'))
  onInvalidate?.('hash-sibling')
  assert.equal(getCachedWorkspace('hash-sibling'), null)
})
