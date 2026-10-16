import test from 'node:test'
import assert from 'node:assert/strict'
import {
  computeBaseline, readStoredBaseline, predictBuilder, predictDeveloper, sameParty, baselineSameEntity, toCandidate,
} from '../scripts/eval-relationship-graph.ts'
import { CASES } from '../eval/datasets/v2/relationship-graph/cases.ts'
import { PAIRS } from '../eval/datasets/v2/relationship-graph/pairs.ts'
import { DRAFTS } from '../eval/datasets/v2/relationship-graph/drafts.ts'
import { TRADE_IDS } from '../packages/backend-core/src/lib/opportunityTaxonomy.ts'

// Offline, deterministic: fixtures only, no key, no network, no database, no clock.

test('gold set is well formed and large enough to start from', () => {
  assert.ok(CASES.length >= 30, `need >= 30 labelled projects, have ${CASES.length}`)
  assert.equal(new Set(CASES.map(c => c.id)).size, CASES.length, 'case ids are unique')
  const recordIds = CASES.flatMap(c => c.records.map(r => r.recordId))
  assert.equal(new Set(recordIds).size, recordIds.length, 'record ids are unique')
  for (const c of CASES) {
    assert.ok(c.records.length >= 1, `${c.id}: has records`)
    if (c.truth.builder.status === 'CONFLICT') assert.ok(c.truth.builder.candidates.length >= 2, `${c.id}: a conflict needs >= 2 candidates`)
    for (const trade of Object.keys(c.truth.trades)) assert.ok((TRADE_IDS as readonly string[]).includes(trade), `${c.id}: unknown trade ${trade}`)
    for (const r of c.records) assert.match(r.publishedAt, /^\d{4}-\d{2}-\d{2}$/, `${r.recordId}: date`)
  }
})

test('gold set covers every dimension the design requires', () => {
  const strata = new Set(CASES.map(c => c.stratum))
  for (const s of ['award_abn', 'award_name_only', 'award_not_builder', 'da_only', 'da_plus_award', 'conflict', 'supersession', 'roles', 'trade_only']) {
    assert.ok(strata.has(s), `missing stratum ${s}`)
  }
  assert.ok(CASES.some(c => c.truth.builder.status === 'UNKNOWN'), 'has unknown-state cases')
  assert.ok(CASES.some(c => c.truth.builder.status === 'CONFLICT'), 'has conflict cases')
  const labels = new Set(CASES.flatMap(c => Object.values(c.truth.trades)))
  assert.deepEqual([...labels].sort(), ['ABSENT', 'IMPLIED', 'STATED'])
  assert.ok(PAIRS.some(p => p.same) && PAIRS.some(p => !p.same), 'pairs include both same and different')
  assert.ok(DRAFTS.some(d => d.unsupported === 'none') && DRAFTS.some(d => d.unsupported !== 'none'), 'drafts include grounded and ungrounded')
})

test('fixtures are synthetic: ABNs use the reserved invented prefix and no URL points at a real host', () => {
  const abns = [
    ...CASES.flatMap(c => c.records.flatMap(r => (r.counterparty?.abn ? [r.counterparty.abn] : []))),
    ...CASES.flatMap(c => (c.truth.builder.status === 'KNOWN' && c.truth.builder.abn ? [c.truth.builder.abn] : [])),
    ...PAIRS.flatMap(p => [p.a.abn, p.b.abn].filter((a): a is string => !!a)),
  ]
  for (const a of abns) assert.match(a, /^11000000\d{3}$/, `ABN ${a} must be in the invented 11000000xxx range`)
  for (const d of DRAFTS) for (const f of d.facts) if (f.sourceUrl) assert.match(f.sourceUrl, /^https:\/\/example\.invalid\//)
})

test('baseline is deterministic and matches the recorded baseline.json', () => {
  const a = computeBaseline()
  const b = computeBaseline()
  assert.deepEqual(a, b)
  assert.deepEqual(a, readStoredBaseline(), 'run `npx tsx scripts/eval-relationship-graph.ts --write` and review the diff if the baseline legitimately changed')
})

test('baseline predictors: latest award wins, no award is UNKNOWN, buyer is the developer', () => {
  const f4 = CASES.find(c => c.id === 'F4')!
  const p = predictBuilder(f4.records)
  assert.equal(p.status, 'KNOWN')
  assert.equal(p.status === 'KNOWN' && p.party.name, 'Skyline Roofing Pty Ltd')
  assert.deepEqual(predictBuilder(CASES.find(c => c.id === 'D1')!.records), { status: 'UNKNOWN' })
  assert.equal(predictDeveloper(CASES.find(c => c.id === 'A1')!.records), 'Northgate Regional Council')
  assert.equal(predictDeveloper(CASES.find(c => c.id === 'D1')!.records), null)
  assert.equal(toCandidate(f4.records[0]).publishedAt?.toISOString(), '2026-08-01T00:00:00.000Z')
})

test('party and entity matching rules', () => {
  assert.equal(sameParty({ name: 'A Pty Ltd', abn: '11000000001' }, { name: 'B', abn: '11000000001' }), true)
  assert.equal(sameParty({ name: 'Same', abn: '11000000001' }, { name: 'Same', abn: '11000000002' }), false, 'ABN beats name when both are present')
  assert.equal(sameParty({ name: 'Acme Pty Ltd' }, { name: 'ACME' }), true)
  // The baseline's dedupe rule has no ABN-conflict check: this is the false merge the graph must remove.
  assert.equal(baselineSameEntity({ name: 'Same Pty Ltd', abn: '11000000001' }, { name: 'Same Pty Ltd', abn: '11000000002' }), true)
  assert.equal(baselineSameEntity({ name: 'Marlow & Sons' }, { name: 'Marlow and Sons' }), false)
})

test('baseline findings the graph must improve on (recorded, not thresholds)', () => {
  const m = readStoredBaseline()
  assert.equal(m.conflicts.detected, 0, 'baseline has no conflict concept')
  assert.equal(m.conflicts.silentlyResolvedToOneBuilder, m.conflicts.conflictCases)
  assert.ok(m.unknownStates.fabricatedBuilder > 0, 'baseline names a builder on notices that do not appoint one')
  assert.equal(m.licence.assertionShare, 1, 'every baseline builder assertion rests on a non-confirmed source today')
  assert.ok(m.grounding.byKind.misattributed_party && m.grounding.byKind.misattributed_party.flagged === 0, 'wrong-party claims pass the current grounding check')
})
