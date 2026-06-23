import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computeLeadScore, explainLeadScore, getScoreTier, DEFAULT_SCORING_WEIGHTS } from '../packages/backend-core/src/lib/scoring.js'

function lead(overrides: Partial<Parameters<typeof computeLeadScore>[0]> = {}): Parameters<typeof computeLeadScore>[0] {
  return {
    businessName: 'Test Co',
    category: null,
    contactName: null,
    email: null,
    website: null,
    notes: null,
    aiSummary: null,
    outreachAngle: null,
    ...overrides
  }
}

describe('computeLeadScore', () => {
  it('returns 0-100 for minimal lead', () => {
    const s = computeLeadScore(lead())
    assert.ok(s >= 0 && s <= 100, `Score ${s} out of range`)
  })

  it('boosts score for ICP industry category', () => {
    const generic = computeLeadScore(lead({ category: 'retail' }))
    const icp = computeLeadScore(lead({ category: 'electrical contractor' }))
    assert.ok(icp > generic, `ICP ${icp} should beat generic ${generic}`)
  })

  it('boosts score when email is present', () => {
    const noEmail = computeLeadScore(lead())
    const withEmail = computeLeadScore(lead({ email: 'owner@acme.com' }))
    assert.ok(withEmail > noEmail, `withEmail ${withEmail} should beat noEmail ${noEmail}`)
  })

  it('boosts score when contactName is present', () => {
    const noContact = computeLeadScore(lead())
    const withContact = computeLeadScore(lead({ contactName: 'Jane Smith' }))
    assert.ok(withContact > noContact)
  })

  it('boosts score for hiring keywords in notes', () => {
    const noHiring = computeLeadScore(lead({ notes: 'General operations company' }))
    const hiring = computeLeadScore(lead({ notes: 'Now hiring field technicians — growing fast' }))
    assert.ok(hiring > noHiring, `Hiring ${hiring} should beat noHiring ${noHiring}`)
  })

  it('boosts score for growth keywords in aiSummary', () => {
    const base = computeLeadScore(lead())
    const growing = computeLeadScore(lead({ aiSummary: 'Company expanding into new contracts and recently raised funding' }))
    assert.ok(growing > base)
  })

  it('penalises high-tech adoption (inverse scoring)', () => {
    const lowTech = computeLeadScore(lead({ aiSummary: 'Small team using paper forms' }))
    const highTech = computeLeadScore(lead({ aiSummary: 'Uses Salesforce CRM and enterprise software suite' }))
    assert.ok(lowTech > highTech, `Low-tech ${lowTech} should beat high-tech ${highTech}`)
  })

  it('boosts score when aiSummary contains growth/hiring keywords', () => {
    // dataFreshness weight is 0, but keywords in aiSummary flow into growth+hiring signals
    const noResearch = computeLeadScore(lead())
    const researched = computeLeadScore(lead({ aiSummary: 'Company expanding and now hiring field staff' }))
    assert.ok(researched > noResearch)
  })

  it('score is higher for a fully-qualified ICP lead', () => {
    const minimal = computeLeadScore(lead())
    const perfect = computeLeadScore(lead({
      category: 'plumbing contractor',
      email: 'ceo@bestplumbing.com',
      contactName: 'John Doe',
      website: 'https://bestplumbing.com',
      notes: 'Now hiring plumbers — expanding into new regions',
      aiSummary: 'Growing plumbing contractor with 30 field staff. No FSM software in use. Scheduling done via WhatsApp.'
    }))
    assert.ok(perfect > minimal, `Perfect ${perfect} should beat minimal ${minimal}`)
    assert.ok(perfect >= 70, `Fully qualified lead should score ≥70, got ${perfect}`)
  })

  it('uses custom weights correctly', () => {
    const weights = { ...DEFAULT_SCORING_WEIGHTS, industry: 0, contact: 1.0, size: 0, hiring: 0, tech: 0, growth: 0, messageRelevance: 0, channelFit: 0, timingFit: 0, dataFreshness: 0 }
    const withEmail = computeLeadScore(lead({ email: 'a@b.com' }), weights)
    const noEmail = computeLeadScore(lead(), weights)
    assert.ok(withEmail > noEmail)
  })

  it('never returns below 0', () => {
    const s = computeLeadScore(lead({ category: 'completely unrelated industry' }))
    assert.ok(s >= 0)
  })

  it('never returns above 100', () => {
    const s = computeLeadScore(lead({
      category: 'civil engineering contractor',
      email: 'a@b.com', contactName: 'Jane',
      aiSummary: 'hiring expanding new contracts growth',
      notes: 'hiring expanding growth funded'
    }))
    assert.ok(s <= 100)
  })
})

describe('explainLeadScore', () => {
  it('returns a score identical to computeLeadScore', () => {
    const l = lead({
      category: 'plumbing contractor',
      email: 'ceo@bestplumbing.com',
      contactName: 'John Doe',
      notes: 'Now hiring plumbers — expanding into new regions',
    })
    assert.equal(explainLeadScore(l).score, computeLeadScore(l))
  })

  it('exposes every weighted signal in the breakdown', () => {
    const { signals } = explainLeadScore(lead())
    for (const k of Object.keys(DEFAULT_SCORING_WEIGHTS)) {
      assert.equal(typeof signals[k as keyof typeof signals], 'number', `missing signal ${k}`)
    }
  })

  it('orders reasons by weighted contribution (desc) and computes contribution = value × weight', () => {
    const { reasons } = explainLeadScore(lead({ category: 'electrical contractor' }))
    for (let i = 1; i < reasons.length; i++) {
      assert.ok(reasons[i - 1].contribution >= reasons[i].contribution, 'reasons must be sorted by contribution desc')
    }
    const top = reasons[0]
    assert.ok(Math.abs(top.contribution - top.value * top.weight) < 1e-9)
  })

  it('surfaces the ICP industry match as a headline reason for a core-vertical lead', () => {
    const { topReasons } = explainLeadScore(lead({ category: 'plumbing contractor' }))
    assert.ok(topReasons.length > 0 && topReasons.length <= 3)
    assert.ok(topReasons.some((r) => /ICP industry match/i.test(r)), `expected an industry reason, got ${JSON.stringify(topReasons)}`)
  })

  it('excludes constant placeholder signals (size/messageRelevance/timingFit) from topReasons', () => {
    const { topReasons } = explainLeadScore(lead({ category: 'plumbing contractor' }))
    assert.ok(!topReasons.some((r) => /default — needs/i.test(r)), 'placeholder defaults must not appear in topReasons')
  })

  it('tier matches getScoreTier(score)', () => {
    const e = explainLeadScore(lead({ category: 'plumbing contractor', email: 'a@b.com', contactName: 'Jane' }))
    assert.equal(e.tier, getScoreTier(e.score))
  })

  it('does not throw on custom/legacy weight keys outside the canonical signal set', () => {
    // A workspace can store arbitrary weight keys; topReasons must skip unknown
    // keys (no label) instead of crashing the scoring path.
    const legacyWeights = { hasEmail: 30, hasWebsite: 10, hasContactName: 10 } as unknown as typeof DEFAULT_SCORING_WEIGHTS
    const e = explainLeadScore(lead({ email: 'a@b.com' }), legacyWeights)
    assert.deepEqual(e.topReasons, [])
    assert.ok(Array.isArray(e.reasons))
  })
})

describe('getScoreTier', () => {
  it('returns HOT for score >= 72', () => {
    assert.equal(getScoreTier(72), 'HOT')
    assert.equal(getScoreTier(100), 'HOT')
    assert.equal(getScoreTier(80), 'HOT')
  })

  it('returns WARM for score 48-71', () => {
    assert.equal(getScoreTier(48), 'WARM')
    assert.equal(getScoreTier(60), 'WARM')
    assert.equal(getScoreTier(71), 'WARM')
  })

  it('returns COLD for score < 48', () => {
    assert.equal(getScoreTier(0), 'COLD')
    assert.equal(getScoreTier(47), 'COLD')
    assert.equal(getScoreTier(1), 'COLD')
  })
})
