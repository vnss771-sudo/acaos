// Deterministic pre-send message relevance (lib/messageRelevance.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeMessageRelevance, MESSAGE_RELEVANCE_VERSION, type RelevanceInput } from '../packages/backend-core/src/lib/messageRelevance.ts'

const lead = {
  businessName: 'Ironclad Engineering', category: 'Engineering', city: 'Brisbane',
  aiSummary: 'Structural fabrication firm currently hiring six welders for a new Ipswich site.',
  outreachAngle: 'Help them staff the Ipswich expansion faster', notes: null,
}
const icp = { targetIndustries: ['Engineering', 'Construction'], businessType: 'Labour hire', businessContext: 'We supply qualified welders and fabricators on short notice.' }
const input = (subject: string, body: string, over: Partial<RelevanceInput> = {}): RelevanceInput => ({ subject, body, lead, icp, ...over })

const tailored = input('Welders for your Ipswich site',
  'Hi Ironclad Engineering team — saw you are hiring welders for the new Ipswich site in Brisbane. We supply qualified welders and fabricators on short notice.')
const generic = input('Quick question', 'Dear Sir/Madam, we offer great solutions for businesses like yours. Let me know if interested.')

test('a tailored, on-offer, signal-aware message scores high; a generic template scores low', () => {
  const hi = computeMessageRelevance(tailored)
  const lo = computeMessageRelevance(generic)
  assert.ok(hi.score >= 0.85, `tailored=${hi.score}`)
  assert.ok(lo.score <= 0.45, `generic=${lo.score}`)
  assert.equal(hi.components.signal, 1)
  assert.equal(hi.components.industry, 1)
  assert.equal(lo.components.signal, 0.25, 'a known signal that the message ignores is penalised')
  assert.ok(lo.reasons.some(r => r.includes('Generic template opener')))
  // Every reason carries its points; the points sum to the score (±rounding).
  assert.ok(hi.reasons.every(r => /^\+\d+ /.test(r)))
  const pts = hi.reasons.reduce((sum, r) => sum + Number(r.match(/^\+(\d+)/)![1]), 0)
  assert.ok(Math.abs(pts - hi.score * 100) <= 3, `points=${pts} score=${hi.score}`)
  assert.equal(hi.reasons[0], '+30 Industry "Engineering" is a target industry')
  // Exact component values, so each rule is individually pinned.
  assert.equal(hi.components.evidence, 1, 'cites the name, city and research specifics')
  assert.equal(lo.components.evidence, 0, 'cites nothing about the prospect')
  assert.equal(hi.components.context, 1)
  assert.equal(lo.components.context, 0, 'generic opener (-0.6) and does not name the prospect (-0.4)')
})

test('every component and the total stay within 0–1, and the version is stamped', () => {
  for (const r of [computeMessageRelevance(tailored), computeMessageRelevance(generic)]) {
    assert.ok(r.score >= 0 && r.score <= 1)
    for (const v of Object.values(r.components)) assert.ok(v >= 0 && v <= 1)
    assert.equal(r.version, MESSAGE_RELEVANCE_VERSION)
  }
})

test('unknowns are neutral, not zero: no ICP means industry and offer score 0.5', () => {
  const r = computeMessageRelevance(input(tailored.subject!, tailored.body!, { icp: null }))
  assert.equal(r.components.industry, 0.5)
  assert.equal(r.components.offer, 0.5)
})

test('off-target industry scores 0 for industry fit', () => {
  const r = computeMessageRelevance(input(tailored.subject!, tailored.body!, { lead: { ...lead, category: 'Retail' } }))
  assert.equal(r.components.industry, 0)
})

test('deterministic: identical inputs give identical results', () => {
  assert.deepEqual(computeMessageRelevance(tailored), computeMessageRelevance(tailored))
})

test('it varies across real messages — so, unlike the old constant, learning can use it', () => {
  const scores = new Set([tailored, generic, input('Hello', 'Ironclad Engineering, are you hiring?')].map(i => computeMessageRelevance(i).score))
  assert.equal(scores.size, 3)
})
