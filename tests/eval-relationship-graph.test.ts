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

// ── Label audit ──────────────────────────────────────────────────────────────
// Checks the labels against the record TEXT using its own term table, deliberately NOT
// matchOpportunity or the trade taxonomy, so a label cannot be "right" only because the
// code under measurement agrees with it. It catches inconsistency, not every wrong label:
// a second human reviewer is still required (design D5).
const AUDIT_TERMS: Record<string, string[]> = {
  electrical: ['electrical', 'switchboard', 'switchgear', 'cabling', 'solar', 'lighting', 'substation'],
  plumbing: ['plumbing', 'hydraulic', 'sanitary'],
  hvac: ['hvac', 'air conditioning', 'ventilation', 'chiller'],
  fire_protection: ['fire ', 'sprinkler'],
  carpentry: ['carpentry', 'joinery'],
  painting: ['painting', 'repaint', 'coating'],
  roofing: ['roof', 'guttering'],
  concreting: ['concrete', 'slab'],
  landscaping: ['landscap', 'irrigation', 'turf'],
  demolition: ['demolition'],
  flooring: ['carpet', 'flooring', 'tiling'],
  security: ['security', 'cctv'],
  cleaning: ['cleaning'],
}
const NON_BUILDER_TERMS = ['architectural', 'design services', 'project management', 'quantity surveying', 'cost planning', 'supply only', 'supply of', 'panel']
const textOf = (c: (typeof CASES)[number]): string =>
  c.records.map(r => `${r.title} ${r.description ?? ''} ${(r.classifications ?? []).map(k => k.description ?? '').join(' ')} `).join(' ').toLowerCase()

test('label audit: trade labels agree with the record text', () => {
  for (const c of CASES) {
    const text = textOf(c)
    for (const [trade, label] of Object.entries(c.truth.trades)) {
      const terms = AUDIT_TERMS[trade]
      assert.ok(terms, `${c.id}: audit has no terms for trade ${trade}`)
      const named = terms.some(t => text.includes(t))
      if (label === 'STATED') assert.ok(named, `${c.id}: ${trade} is STATED but the text never names it`)
      else assert.ok(!named, `${c.id}: ${trade} is ${label} but the text names it, so it should be STATED`)
    }
  }
})

test('label audit: builder labels agree with the records and the role definitions', () => {
  for (const c of CASES) {
    const awards = c.records.filter(r => r.kind === 'CONTRACT_AWARD' && r.counterparty)
    const t = c.truth.builder
    const text = textOf(c)
    if (t.status === 'KNOWN') {
      const latest = [...awards].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt)).at(-1)
      assert.ok(latest, `${c.id}: KNOWN builder needs an award record`)
      assert.equal(latest.counterparty!.name, t.name, `${c.id}: truth builder must be the latest award's counterparty (supersession policy)`)
      assert.equal(latest.counterparty!.abn, t.abn, `${c.id}: ABN agrees`)
      for (const term of NON_BUILDER_TERMS) assert.ok(!text.includes(term), `${c.id}: text says "${term}", so the supplier is not a builder`)
      assert.notEqual(latest.counterparty!.name, latest.buyer?.name, `${c.id}: a self-award names no external builder`)
    } else if (t.status === 'UNKNOWN') {
      const reason = awards.length === 0 ||
        NON_BUILDER_TERMS.some(term => text.includes(term)) ||
        awards.every(a => a.counterparty!.name === a.buyer?.name)
      assert.ok(reason, `${c.id}: UNKNOWN builder needs no award, a non-builder service, a panel, or a self-award`)
    } else {
      const distinct = new Set(awards.map(a => a.externalId))
      assert.ok(distinct.size >= 2, `${c.id}: a conflict needs >= 2 distinct notices`)
      assert.ok(new Set(awards.map(a => a.counterparty!.name)).size >= 2, `${c.id}: a conflict needs >= 2 different suppliers`)
    }
    if (c.stratum === 'supersession') assert.equal(new Set(c.records.map(r => r.externalId)).size, 1, `${c.id}: supersession is one notice re-delivered`)
    if (c.stratum === 'conflict') assert.equal(t.status, 'CONFLICT')
  }
})

test('label audit: developer label is the award buyer, or null when no award names one', () => {
  for (const c of CASES) {
    const buyers = new Set(c.records.filter(r => r.kind === 'CONTRACT_AWARD').flatMap(r => (r.buyer ? [r.buyer.name] : [])))
    if (c.truth.developer === null) assert.equal(buyers.size, 0, `${c.id}: null developer but a record names a buyer`)
    else assert.ok(buyers.has(c.truth.developer), `${c.id}: developer ${c.truth.developer} is not an award buyer`)
  }
})

test('label audit: every entity pair states its basis and is consistent with its ABNs', () => {
  for (const p of PAIRS) {
    assert.ok(p.labelBasis.trim().length > 10, `${p.id}: needs a labelBasis`)
    if (p.a.abn && p.b.abn) assert.equal(p.same, p.a.abn === p.b.abn, `${p.id}: truth disagrees with the ABNs given`)
  }
})
