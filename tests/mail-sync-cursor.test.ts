// Unit test for the mailbox reply-sync windowing (no DB/IMAP). Verifies the cursor
// math that guarantees no reply is silently skipped: with a live cursor we fetch
// strictly above it; on first sync we bound to a recent window.

import test from 'node:test'
import assert from 'node:assert/strict'
import { computeMailboxFetchStart } from '../packages/backend-core/src/services/mail.ts'

test('with a live cursor, fetch starts strictly above it (nothing skipped)', () => {
  assert.equal(computeMailboxFetchStart({ cursor: 1500, uidNext: 1600, exists: 1599 }), 1501)
  // No upper bound — even a huge gap since last sync is fetched, not capped at 200.
  assert.equal(computeMailboxFetchStart({ cursor: 10, uidNext: 100000, exists: 99999 }), 11)
})

test('first sync (cursor 0) bounds to a recent window via uidNext', () => {
  assert.equal(computeMailboxFetchStart({ cursor: 0, uidNext: 1000, exists: 999 }), 800)
})

test('first sync falls back to exists+1 when uidNext is unknown', () => {
  assert.equal(computeMailboxFetchStart({ cursor: 0, uidNext: null, exists: 1000 }), 801)
})

test('never returns below 1 on a small or empty mailbox', () => {
  assert.equal(computeMailboxFetchStart({ cursor: 0, uidNext: 5, exists: 4 }), 1)
  assert.equal(computeMailboxFetchStart({ cursor: 0, uidNext: null, exists: null }), 1)
})

test('respects a custom recent window', () => {
  assert.equal(computeMailboxFetchStart({ cursor: 0, uidNext: 1000, exists: 999, recentWindow: 50 }), 950)
})
