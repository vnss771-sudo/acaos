// Unit tests for the send-campaign dedup job-id (the BullMQ collapse key).
// Pure logic with an injectable clock — no Redis needed.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sendCampaignJobId } from '../packages/backend-core/src/lib/queues.ts'

const minute = 60_000

test('same campaign + lead set within a minute collapses to one id', () => {
  const a = sendCampaignJobId('c1', 'w1', ['l1', 'l2'], 5 * minute + 100)
  const b = sendCampaignJobId('c1', 'w1', ['l1', 'l2'], 5 * minute + 59_000)
  assert.equal(a, b)
})

test('lead order does not matter (set is sorted before hashing)', () => {
  const a = sendCampaignJobId('c1', 'w1', ['l1', 'l2', 'l3'], 0)
  const b = sendCampaignJobId('c1', 'w1', ['l3', 'l1', 'l2'], 0)
  assert.equal(a, b)
})

test('"send all" (no leadIds) is distinct from a specific subset', () => {
  const all = sendCampaignJobId('c1', 'w1', undefined, 0)
  const subset = sendCampaignJobId('c1', 'w1', ['l1'], 0)
  assert.notEqual(all, subset)
  assert.match(all, /^send-campaign-w1-c1-[0-9a-f]{16}-0$/)
})

test('crossing a minute boundary produces a new id (allows a later relaunch)', () => {
  const t0 = sendCampaignJobId('c1', 'w1', ['l1'], 5 * minute + 59_000)
  const t1 = sendCampaignJobId('c1', 'w1', ['l1'], 6 * minute + 1_000)
  assert.notEqual(t0, t1)
})

test('contains no ":" (forbidden in BullMQ custom job ids)', () => {
  assert.ok(!sendCampaignJobId('c1', 'w1', ['l1', 'l2'], 0).includes(':'))
})

test('different workspace or campaign yields different ids', () => {
  const base = sendCampaignJobId('c1', 'w1', ['l1'], 0)
  assert.notEqual(base, sendCampaignJobId('c1', 'w2', ['l1'], 0))
  assert.notEqual(base, sendCampaignJobId('c2', 'w1', ['l1'], 0))
})
