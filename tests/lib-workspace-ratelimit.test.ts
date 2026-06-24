import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { enforceWorkspaceAiRate, _resetWorkspaceAiRateForTest } from '../apps/api/src/lib/workspaceRateLimit.ts'

// No Redis in the unit tier → the limiter uses its in-process fallback, which is
// exactly what we exercise here. Restore env + counters after each case.
const saved = process.env.WORKSPACE_AI_RATE_MAX
afterEach(() => {
  if (saved === undefined) delete process.env.WORKSPACE_AI_RATE_MAX
  else process.env.WORKSPACE_AI_RATE_MAX = saved
  delete process.env.RATE_LIMIT_DISABLED
  _resetWorkspaceAiRateForTest()
})

test('allows up to the per-workspace max, then rejects with 429', async () => {
  process.env.WORKSPACE_AI_RATE_MAX = '3'
  const ws = 'ws-cap'
  for (let i = 0; i < 3; i++) await enforceWorkspaceAiRate(ws)
  await assert.rejects(() => enforceWorkspaceAiRate(ws), /Workspace AI rate limit/)
})

test('buckets are independent per workspace (one at the cap never blocks another)', async () => {
  process.env.WORKSPACE_AI_RATE_MAX = '1'
  await enforceWorkspaceAiRate('ws-a')
  await assert.rejects(() => enforceWorkspaceAiRate('ws-a'), /Workspace AI rate limit/)
  await assert.doesNotReject(() => enforceWorkspaceAiRate('ws-b'))
})

test('WORKSPACE_AI_RATE_MAX=0 disables the limit', async () => {
  process.env.WORKSPACE_AI_RATE_MAX = '0'
  for (let i = 0; i < 25; i++) await assert.doesNotReject(() => enforceWorkspaceAiRate('ws-off'))
})

test('RATE_LIMIT_DISABLED short-circuits (test/E2E escape hatch)', async () => {
  process.env.WORKSPACE_AI_RATE_MAX = '1'
  process.env.RATE_LIMIT_DISABLED = 'true'
  for (let i = 0; i < 5; i++) await assert.doesNotReject(() => enforceWorkspaceAiRate('ws-eh'))
})
