// Integrity tests for the industry packs: the registry is consistent, and every
// template is mapped to signals the pack actually tracks (template ⇄ evidence).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listPacks, getPack } from '../apps/api/src/lib/packs/index.ts'

test('listPacks returns summaries and getPack resolves each', () => {
  const summaries = listPacks()
  assert.ok(summaries.length >= 1)
  for (const s of summaries) {
    assert.ok(s.id && s.label && s.description, 'summary fields present')
    assert.ok(getPack(s.id), `getPack resolves ${s.id}`)
  }
})

test('getPack returns undefined for an unknown id', () => {
  assert.equal(getPack('nope'), undefined)
})

test('FieldOps pack is well-formed and templates map to tracked signals', () => {
  const pack = getPack('fieldops')
  assert.ok(pack)
  assert.ok(pack!.icp.targetIndustries.length > 0, 'ICP has industries')
  assert.ok(pack!.signals.length > 0, 'pack defines signals')
  const tracked = new Set(pack!.signals.map((s) => s.type))
  assert.ok(pack!.templates.length > 0, 'pack has templates')
  for (const t of pack!.templates) {
    assert.ok(t.subject && t.body && t.angle, `template ${t.id} has copy`)
    assert.ok(t.evidenceSignals.length > 0, `template ${t.id} maps to evidence`)
    for (const sig of t.evidenceSignals) {
      assert.ok(tracked.has(sig), `template ${t.id} references tracked signal ${sig}`)
    }
  }
})
