// UQ-17: the versioned eval manifest stays in sync with the repo, and live-eval
// run metadata records real provider usage without inventing any.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { startEvalRun, EVAL_DATASET_VERSION } from '../scripts/lib/evalRun.ts'
import { appendEvalRun } from '../scripts/lib/evalHistory.ts'
import { model, type AiProviderCallMeta } from '../packages/backend-core/src/services/openai.ts'

type Manifest = { version: string; suites: Array<{ task: string; offline: string[]; live?: string }> }
const manifest = JSON.parse(readFileSync('eval/datasets/v1/manifest.json', 'utf8')) as Manifest

test('every suite in the eval manifest exists and live suites name real npm scripts', () => {
  const scripts = (JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }).scripts
  assert.equal(manifest.version, EVAL_DATASET_VERSION)
  assert.deepEqual(manifest.suites.map(s => s.task), ['research', 'outreach', 'reply-classification', 'claim-grounding', 'recommendations'])
  for (const s of manifest.suites) {
    for (const f of s.offline) assert.ok(existsSync(f), `${s.task}: ${f} is missing`)
    if (s.live) assert.ok(scripts[s.live], `${s.task}: npm script ${s.live} is missing`)
  }
})

type Observer = ((m: AiProviderCallMeta) => void) | undefined

/** startEvalRun with a captured observer, standing in for real provider calls. */
function captured() {
  let observer: Observer
  const finish = startEvalRun((o: Observer) => { observer = o })
  return { call: (m: AiProviderCallMeta) => observer?.(m), finish, cleared: () => observer === undefined }
}
const usage = (promptTokens: number | null, completionTokens: number | null, totalTokens: number | null): AiProviderCallMeta =>
  ({ model: 'gpt-5-mini', deploymentState: 'ACTIVE', latencyMs: 5, promptTokens, completionTokens, totalTokens })

test('a live run sums provider-reported tokens, records the active model and removes its observer', () => {
  const run = captured()
  run.call(usage(100, 40, 140))
  run.call(usage(50, 10, 60))
  const t = run.finish()
  assert.deepEqual([t.promptTokens, t.completionTokens, t.totalTokens], [150, 50, 200])
  assert.equal(t.model, model())
  assert.equal(t.datasetVersion, 'v1')
  assert.ok(t.latencyMs >= 0)
  assert.ok(run.cleared())
})

test('without provider usage the token fields stay null rather than zero', () => {
  const run = captured()
  run.call(usage(null, null, null))
  const t = run.finish()
  assert.deepEqual([t.promptTokens, t.completionTokens, t.totalTokens], [null, null, null])
})

test('history keeps the extended run metadata alongside older entries', () => {
  const old = { recordedAt: '2026-01-01T00:00:00.000Z', score: 90, fails: 0, warns: 1, cases: 3 }
  const next = { ...old, recordedAt: '2026-10-09T00:00:00.000Z', task: 'outreach', datasetVersion: 'v1', promptVersion: 4, latencyMs: 1234, promptTokens: 10, completionTokens: 5, totalTokens: 15 }
  assert.deepEqual(appendEvalRun([old], next), [old, next])
})
