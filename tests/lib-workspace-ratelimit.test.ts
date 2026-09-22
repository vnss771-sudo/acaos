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

// degradedMax: the unit tier has no Redis, so every call already takes the
// in-process fallback path — exactly what a real outage degrades to. A
// multi-pod deployment's real aggregate ceiling during an outage is
// (pod count × max) since each pod counts independently, so production
// tightens to degradedMax (30) instead of the configured max.
test('degradedMax (30) tightens the fallback ceiling in production', async () => {
  const prevEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  process.env.WORKSPACE_AI_RATE_MAX = '100'
  try {
    const ws = 'ws-degraded'
    for (let i = 0; i < 30; i++) await enforceWorkspaceAiRate(ws)
    await assert.rejects(() => enforceWorkspaceAiRate(ws), /Workspace AI rate limit/)
  } finally {
    if (prevEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = prevEnv
  }
})

test('degradedMax is ignored outside production (configured max applies)', async () => {
  // NODE_ENV is unset/test here, so degradedMax must NOT apply.
  process.env.WORKSPACE_AI_RATE_MAX = '35'
  const ws = 'ws-not-degraded'
  for (let i = 0; i < 35; i++) await enforceWorkspaceAiRate(ws)
  await assert.rejects(() => enforceWorkspaceAiRate(ws), /Workspace AI rate limit/)
})
