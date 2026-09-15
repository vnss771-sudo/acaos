// Pure-logic tests for the queue-depth-adaptive concurrency decision function —
// isolated from BullMQ/Redis (see tests-redis/adaptive-concurrency.test.ts for
// the live-Redis integration tier).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  nextAdaptiveState,
  initialAdaptiveState,
  loadAdaptiveConfigFromEnv,
  type AdaptiveConcurrencyConfig,
} from '../apps/worker/src/lib/adaptiveConcurrency.ts'

const baseConfig: AdaptiveConcurrencyConfig = {
  min: 1,
  max: 5,
  scaleUpAt: 5,
  scaleDownAt: 0,
  step: 1,
  confirmTicks: 2,
}

test('holds when the queue depth is between the scale-up and scale-down thresholds', () => {
  const state = initialAdaptiveState(3)
  const { state: next, action } = nextAdaptiveState(state, 2, baseConfig)
  assert.equal(action, 'hold')
  assert.equal(next.concurrency, 3)
})

test('requires confirmTicks consecutive high-depth polls before scaling up (damping)', () => {
  let state = initialAdaptiveState(2)
  const config = { ...baseConfig, confirmTicks: 3 }

  let r = nextAdaptiveState(state, 10, config)
  assert.equal(r.action, 'hold', 'tick 1: not yet confirmed')
  state = r.state

  r = nextAdaptiveState(state, 10, config)
  assert.equal(r.action, 'hold', 'tick 2: still not confirmed')
  state = r.state

  r = nextAdaptiveState(state, 10, config)
  assert.equal(r.action, 'scale-up', 'tick 3: confirmed, scales up')
  assert.equal(r.state.concurrency, 3)
})

test('a single low-depth tick resets an in-progress scale-up streak (no thrash)', () => {
  let state = initialAdaptiveState(2)
  const config = { ...baseConfig, confirmTicks: 2 }

  let r = nextAdaptiveState(state, 10, config) // 1st confirming tick
  assert.equal(r.action, 'hold')
  state = r.state
  assert.equal(state.streak, 1)

  r = nextAdaptiveState(state, 0, config) // depth drops — breaks the up-streak
  assert.equal(r.action, 'hold')
  state = r.state
  assert.equal(state.streak, 1, 'streak restarts toward "down" rather than continuing "up"')
  assert.equal(state.pending, 'down')

  r = nextAdaptiveState(state, 10, config) // back up again — streak must restart, not resume at 2
  assert.equal(r.action, 'hold', 'the earlier scale-up progress was correctly discarded')
})

test('scales down toward min after confirmTicks consecutive idle polls', () => {
  let state = initialAdaptiveState(5)
  const config = { ...baseConfig, confirmTicks: 2 }

  let r = nextAdaptiveState(state, 0, config)
  assert.equal(r.action, 'hold')
  state = r.state

  r = nextAdaptiveState(state, 0, config)
  assert.equal(r.action, 'scale-down')
  assert.equal(r.state.concurrency, 4)
})

test('never scales below min, even with sustained zero depth', () => {
  let state = initialAdaptiveState(2)
  const config = { ...baseConfig, min: 1, max: 5, confirmTicks: 1 }
  for (let i = 0; i < 10; i++) {
    const r = nextAdaptiveState(state, 0, config)
    state = r.state
  }
  assert.equal(state.concurrency, 1)
})

test('never scales above max, even with sustained heavy backlog', () => {
  let state = initialAdaptiveState(4)
  const config = { ...baseConfig, min: 1, max: 5, confirmTicks: 1 }
  for (let i = 0; i < 10; i++) {
    const r = nextAdaptiveState(state, 1000, config)
    state = r.state
  }
  assert.equal(state.concurrency, 5)
})

test('never produces a concurrency below 1 even if min is misconfigured to 0', () => {
  const state = initialAdaptiveState(1)
  const config = { ...baseConfig, min: 0, max: 3, confirmTicks: 1, scaleDownAt: 5 }
  const r = nextAdaptiveState(state, 0, config)
  assert.ok(r.state.concurrency >= 1)
})

test('when min === max (a queue whose static concurrency is 1), it always holds', () => {
  const state = initialAdaptiveState(1)
  const config = { ...baseConfig, min: 1, max: 1, confirmTicks: 1 }
  const up = nextAdaptiveState(state, 999, config)
  assert.equal(up.action, 'hold')
  assert.equal(up.state.concurrency, 1)
  const down = nextAdaptiveState(state, 0, config)
  assert.equal(down.action, 'hold')
  assert.equal(down.state.concurrency, 1)
})

test('initialAdaptiveState clamps a fractional/zero starting concurrency to a sane integer >= 1', () => {
  assert.equal(initialAdaptiveState(0).concurrency, 1)
  assert.equal(initialAdaptiveState(3.7).concurrency, 4)
})

test('step > 1 moves concurrency by that amount per confirmed decision, still clamped', () => {
  const state = initialAdaptiveState(1)
  const config = { ...baseConfig, min: 1, max: 5, step: 3, confirmTicks: 1 }
  const r = nextAdaptiveState(state, 10, config)
  assert.equal(r.action, 'scale-up')
  assert.equal(r.state.concurrency, 4)
})

// ── env config loading ────────────────────────────────────────────────────────

test('loadAdaptiveConfigFromEnv defaults max to the queue static concurrency and min to 1', () => {
  const config = loadAdaptiveConfigFromEnv('research-lead', 3)
  assert.equal(config.max, 3)
  assert.equal(config.min, 1)
  assert.equal(config.scaleUpAt, 3)
  assert.equal(config.scaleDownAt, 0)
})

test('loadAdaptiveConfigFromEnv respects a per-queue max override', () => {
  process.env.WORKER_ADAPTIVE_MAX_RESEARCH_LEAD = '8'
  try {
    const config = loadAdaptiveConfigFromEnv('research-lead', 3)
    assert.equal(config.max, 8)
  } finally {
    delete process.env.WORKER_ADAPTIVE_MAX_RESEARCH_LEAD
  }
})

test('loadAdaptiveConfigFromEnv clamps an oversized min override down to max', () => {
  process.env.WORKER_ADAPTIVE_MIN_RESEARCH_LEAD = '99'
  try {
    const config = loadAdaptiveConfigFromEnv('research-lead', 3)
    assert.equal(config.min, 3)
    assert.equal(config.max, 3)
  } finally {
    delete process.env.WORKER_ADAPTIVE_MIN_RESEARCH_LEAD
  }
})
