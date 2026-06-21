// Unit tests for the launch blast-radius controls (kill-switches + SAFE_LAUNCH_MODE).
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  isFeatureEnabled,
  isSafeLaunchMode,
  safeLaunchDailySendCap,
  effectiveApprovalMode,
  effectiveDailySendLimit,
  launchControlsSnapshot,
} from '../packages/backend-core/src/lib/launchControls.ts'

const KEYS = ['FEATURE_AI', 'FEATURE_SEND', 'FEATURE_MAILBOX_SYNC', 'FEATURE_DISCOVERY', 'SAFE_LAUNCH_MODE', 'SAFE_LAUNCH_DAILY_SEND_CAP']
const saved: Record<string, string | undefined> = {}
beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k] } })
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] } })

test('features default ON when unset', () => {
  assert.equal(isFeatureEnabled('ai'), true)
  assert.equal(isFeatureEnabled('send'), true)
  assert.equal(isFeatureEnabled('mailboxSync'), true)
  assert.equal(isFeatureEnabled('discovery'), true)
})

test('a feature is disabled only by a recognized false token', () => {
  for (const off of ['false', '0', 'off', 'no', 'FALSE', ' Off ']) {
    process.env.FEATURE_SEND = off
    assert.equal(isFeatureEnabled('send'), false, `"${off}" must disable`)
  }
  for (const on of ['true', '1', 'on', 'yes', '']) {
    process.env.FEATURE_SEND = on
    assert.equal(isFeatureEnabled('send'), true, `"${on}" must keep enabled`)
  }
  // An unrecognized value falls back to the default (ON), never silently off.
  process.env.FEATURE_SEND = 'banana'
  assert.equal(isFeatureEnabled('send'), true)
})

test('SAFE_LAUNCH_MODE defaults OFF and turns on only for a true token', () => {
  assert.equal(isSafeLaunchMode(), false)
  process.env.SAFE_LAUNCH_MODE = 'true'
  assert.equal(isSafeLaunchMode(), true)
  process.env.SAFE_LAUNCH_MODE = 'nope'
  assert.equal(isSafeLaunchMode(), false)
})

test('effectiveApprovalMode forces approval under safe-launch, else passes through', () => {
  assert.equal(effectiveApprovalMode(false), false)
  assert.equal(effectiveApprovalMode(true), true)
  process.env.SAFE_LAUNCH_MODE = 'true'
  assert.equal(effectiveApprovalMode(false), true, 'safe-launch forces approval even when the workspace disabled it')
  assert.equal(effectiveApprovalMode(true), true)
})

test('effectiveDailySendLimit clamps to the safe ceiling under safe-launch', () => {
  // Off: pass-through, including "no limit".
  assert.equal(effectiveDailySendLimit(100), 100)
  assert.equal(effectiveDailySendLimit(null), null)
  assert.equal(effectiveDailySendLimit(undefined), null)

  process.env.SAFE_LAUNCH_MODE = 'true'
  assert.equal(safeLaunchDailySendCap(), 20, 'default safe ceiling')
  assert.equal(effectiveDailySendLimit(100), 20, 'clamps a higher workspace cap down')
  assert.equal(effectiveDailySendLimit(5), 5, 'leaves an already-lower cap')
  assert.equal(effectiveDailySendLimit(null), 20, 'imposes the ceiling when the workspace had no cap')
})

test('safeLaunchDailySendCap honors a valid override and ignores junk', () => {
  process.env.SAFE_LAUNCH_DAILY_SEND_CAP = '5'
  assert.equal(safeLaunchDailySendCap(), 5)
  process.env.SAFE_LAUNCH_DAILY_SEND_CAP = '0'
  assert.equal(safeLaunchDailySendCap(), 20, 'non-positive falls back to default')
  process.env.SAFE_LAUNCH_DAILY_SEND_CAP = 'lots'
  assert.equal(safeLaunchDailySendCap(), 20, 'invalid falls back to default')
})

test('launchControlsSnapshot reflects the live environment', () => {
  process.env.FEATURE_AI = 'false'
  process.env.SAFE_LAUNCH_MODE = 'true'
  const snap = launchControlsSnapshot()
  assert.equal(snap.safeLaunchMode, true)
  assert.equal(snap.safeLaunchDailySendCap, 20)
  assert.equal(snap.features.ai, false)
  assert.equal(snap.features.send, true)
})
