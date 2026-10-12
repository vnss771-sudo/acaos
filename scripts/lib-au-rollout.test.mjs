import test from 'node:test'
import assert from 'node:assert/strict'
import { parseRolloutDays, summarizeSentRecord, classifyRolloutExposure } from './lib-au-rollout.mjs'

test('rollout window requires a bounded positive integer', () => {
  assert.equal(parseRolloutDays([]), 90)
  assert.equal(parseRolloutDays(['--days=365']), 365)
  for (const value of ['0', '-1', '366', '1.5', 'abc', '1e9']) {
    assert.throws(() => parseRolloutDays([`--days=${value}`]))
  }
  assert.throws(() => parseRolloutDays(['--days=10', '--days=20']))
})

test('counts only au domain signals, without retaining email addresses', () => {
  const acc = new Map()
  summarizeSentRecord(acc, 'ws1', 'someone@example.com.au')
  summarizeSentRecord(acc, 'ws1', 'other@example.au')
  summarizeSentRecord(acc, 'ws2', 'someone@example.com')
  summarizeSentRecord(acc, 'ws3', 'name@not-au.example')
  summarizeSentRecord(acc, 'ws3', 'person@example.AU')
  const result = classifyRolloutExposure(acc, new Set(['ws3']))
  assert.equal(result.messages, 5)
  assert.equal(result.messagesToAuTld, 3)
  assert.equal(result.unflaggedWorkspacesWithAuTldRecipients, 1)
  assert.deepEqual(result.unflaggedAuSenderWorkspaceIds, [{ id: 'ws1', sent: 2, toAuTld: 2 }])
  assert.equal(JSON.stringify(result).includes('someone@'), false)
})
