// Unit tests for the ingest API-key → workspace cache, including the eviction
// path that key rotation/deletion relies on to invalidate a revoked key.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  getCachedWorkspace,
  setCachedWorkspace,
  evictCachedWorkspace,
} from '../apps/api/src/lib/ingestCache.ts'

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
