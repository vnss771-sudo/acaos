import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { estimateAiCost, aiActionCostCents } from '../packages/backend-core/src/lib/aiCost.ts'

const saved = { ...process.env }
afterEach(() => {
  for (const k of ['AI_COST_CENTS_RESEARCH', 'AI_COST_CENTS_OUTREACH', 'AI_COST_CENTS_REPLY']) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

test('weights each action by its per-call cost and sums the total', () => {
  const r = estimateAiCost({ AI_RESEARCH: 100, AI_OUTREACH: 50, AI_REPLY: 200 })
  // defaults: 0.1, 0.08, 0.05 ¢/call → 10 + 4 + 10 = 24¢
  assert.equal(r.byAction.AI_RESEARCH.costCents, 10)
  assert.equal(r.byAction.AI_OUTREACH.costCents, 4)
  assert.equal(r.byAction.AI_REPLY.costCents, 10)
  assert.equal(r.totalCents, 24)
})

test('ignores zero/negative/unknown counts', () => {
  const r = estimateAiCost({ AI_RESEARCH: 0, AI_OUTREACH: -5 })
  assert.deepEqual(r, { totalCents: 0, byAction: {} })
})

test('rates are tunable via env (for other model tiers)', () => {
  process.env.AI_COST_CENTS_RESEARCH = '0.5'
  assert.equal(aiActionCostCents('AI_RESEARCH'), 0.5)
  assert.equal(estimateAiCost({ AI_RESEARCH: 10 }).totalCents, 5)
})

test('a negative env rate falls back to the default', () => {
  process.env.AI_COST_CENTS_REPLY = '-1'
  assert.equal(aiActionCostCents('AI_REPLY'), 0.05)
})

test('cents are rounded to 2 dp (no float drift in the total)', () => {
  const r = estimateAiCost({ AI_RESEARCH: 3 }) // 0.1 * 3 = 0.30
  assert.equal(r.totalCents, 0.3)
})
