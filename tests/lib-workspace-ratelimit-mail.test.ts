import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { enforceWorkspaceMailRate, _resetWorkspaceMailRateForTest } from '../apps/api/src/lib/workspaceRateLimit.ts'

// Mirrors tests/lib-workspace-ratelimit.test.ts (the AI limiter) — same
// in-process fallback path, distinct bucket/env var so the two never interact.
const saved = process.env.WORKSPACE_MAIL_RATE_MAX
afterEach(() => {
  if (saved === undefined) delete process.env.WORKSPACE_MAIL_RATE_MAX
  else process.env.WORKSPACE_MAIL_RATE_MAX = saved
  delete process.env.RATE_LIMIT_DISABLED
  _resetWorkspaceMailRateForTest()
})

test('allows up to the per-workspace mail max, then rejects with 429', async () => {
  process.env.WORKSPACE_MAIL_RATE_MAX = '3'
  const ws = 'ws-mail-cap'
  for (let i = 0; i < 3; i++) await enforceWorkspaceMailRate(ws)
  await assert.rejects(() => enforceWorkspaceMailRate(ws), /Workspace mail rate limit/)
})

test('mail buckets are independent per workspace', async () => {
  process.env.WORKSPACE_MAIL_RATE_MAX = '1'
  await enforceWorkspaceMailRate('ws-mail-a')
  await assert.rejects(() => enforceWorkspaceMailRate('ws-mail-a'), /Workspace mail rate limit/)
  await assert.doesNotReject(() => enforceWorkspaceMailRate('ws-mail-b'))
})

test('WORKSPACE_MAIL_RATE_MAX=0 disables the limit', async () => {
  process.env.WORKSPACE_MAIL_RATE_MAX = '0'
  for (let i = 0; i < 25; i++) await assert.doesNotReject(() => enforceWorkspaceMailRate('ws-mail-off'))
})

test('RATE_LIMIT_DISABLED short-circuits (test/E2E escape hatch)', async () => {
  process.env.WORKSPACE_MAIL_RATE_MAX = '1'
  process.env.RATE_LIMIT_DISABLED = 'true'
  for (let i = 0; i < 5; i++) await assert.doesNotReject(() => enforceWorkspaceMailRate('ws-mail-eh'))
})

// degradedMax: mirrors tests/lib-workspace-ratelimit.test.ts's AI-limiter case.
test('degradedMax (10) tightens the fallback ceiling in production', async () => {
  const prevEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  process.env.WORKSPACE_MAIL_RATE_MAX = '50'
  try {
    const ws = 'ws-mail-degraded'
    for (let i = 0; i < 10; i++) await enforceWorkspaceMailRate(ws)
    await assert.rejects(() => enforceWorkspaceMailRate(ws), /Workspace mail rate limit/)
  } finally {
    if (prevEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = prevEnv
  }
})

test('degradedMax is ignored outside production (configured max applies)', async () => {
  process.env.WORKSPACE_MAIL_RATE_MAX = '15'
  const ws = 'ws-mail-not-degraded'
  for (let i = 0; i < 15; i++) await enforceWorkspaceMailRate(ws)
  await assert.rejects(() => enforceWorkspaceMailRate(ws), /Workspace mail rate limit/)
})
