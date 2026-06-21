/**
 * Static wiring gates for the launch kill-switches. A kill-switch is only
 * blast-radius control if it's enforced at BOTH layers: the API rejects new work
 * (503) and the worker skips scheduled/in-flight execution. These cheap source
 * checks stop a refactor from silently dropping a guard.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8')

// API edge: each feature's primary entry route applies requireFeature(<feature>).
const API_GATES: Array<{ file: string; feature: string }> = [
  { file: 'apps/api/src/routes/ai.ts', feature: 'ai' },
  { file: 'apps/api/src/routes/campaigns.ts', feature: 'send' },
  { file: 'apps/api/src/routes/mailbox.ts', feature: 'mailboxSync' },
  { file: 'apps/api/src/routes/prospects/discovery.ts', feature: 'discovery' },
]
for (const { file, feature } of API_GATES) {
  test(`launch wiring: ${file} gates its entry route with requireFeature('${feature}')`, () => {
    assert.match(read(file), new RegExp(`requireFeature\\('${feature}'\\)`), `${file} must call requireFeature('${feature}')`)
  })
}

// Worker: each feature-bearing job handler short-circuits when its feature is off.
test('launch wiring: the worker skips disabled-feature jobs', () => {
  const w = read('apps/worker/src/worker.ts')
  for (const f of ['ai', 'send', 'mailboxSync'] as const) {
    assert.match(w, new RegExp(`isFeatureEnabled\\('${f}'\\)`), `worker must check isFeatureEnabled('${f}')`)
  }
})

// Safe-launch safe defaults are applied where outbound is decided.
test('launch wiring: sendCampaignBatch applies safe-launch defaults', () => {
  const p = read('apps/worker/src/processors.ts')
  assert.match(p, /effectiveApprovalMode\(/, 'must force approval via effectiveApprovalMode under safe-launch')
  assert.match(p, /effectiveDailySendLimit\(/, 'must clamp the daily cap via effectiveDailySendLimit under safe-launch')
})
