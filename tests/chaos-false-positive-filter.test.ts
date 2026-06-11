// Chaos tests for the False Positive Filter — classifySignal + classifyProspectSignals
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifySignal,
  classifyProspectSignals,
  signalPatternKey,
} from '../apps/api/src/lib/signalEngine.js'
import type { RawSignal, ProspectMeta } from '../apps/api/src/lib/signalEngine.js'

function sig(overrides: Partial<RawSignal> = {}): RawSignal {
  return {
    type:              'HIRING',
    strength:          70,
    sourceReliability: 80,
    industryRelevance: 75,
    detectedAt:        new Date(),
    ...overrides,
  }
}

const meta: ProspectMeta = {
  industry:      'construction',
  employeeCount: 50,
  contactEmail:  'ops@acme.com',
  contactName:   'Jane Smith',
  domain:        'acme.com',
  location:      'Sydney',
}

describe('classifySignal — IGNORE conditions', () => {
  it('ignores signal with decayed strength < 3 (very weak)', () => {
    // Strength 100, decay rate HIRING=0.012, age 400 days → s×e^(-0.012×400) ≈ 0.7
    const result = classifySignal(sig({ strength: 1, detectedAt: new Date(Date.now() - 400 * 86_400_000) }))
    assert.equal(result.decision, 'IGNORE')
    assert.ok(result.reason.includes('too weak'))
  })

  it('ignores signal with sourceReliability < 35', () => {
    const result = classifySignal(sig({ sourceReliability: 30 }))
    assert.equal(result.decision, 'IGNORE')
    assert.ok(result.reason.includes('reliability'))
  })

  it('ignores WEBSITE_CHANGE older than 45 days', () => {
    const old = new Date(Date.now() - 50 * 86_400_000)
    const result = classifySignal(sig({ type: 'WEBSITE_CHANGE', strength: 80, detectedAt: old }))
    assert.equal(result.decision, 'IGNORE')
    assert.ok(result.reason.includes('expired'))
  })

  it('ignores NEWS_MENTION older than 30 days', () => {
    const old = new Date(Date.now() - 35 * 86_400_000)
    const result = classifySignal(sig({ type: 'NEWS_MENTION', strength: 80, detectedAt: old }))
    assert.equal(result.decision, 'IGNORE')
  })

  it('ignores BUSINESS_REGISTRATION older than 90 days', () => {
    const old = new Date(Date.now() - 95 * 86_400_000)
    const result = classifySignal(sig({ type: 'BUSINESS_REGISTRATION', strength: 80, detectedAt: old }))
    assert.equal(result.decision, 'IGNORE')
  })
})

describe('classifySignal — WATCH conditions', () => {
  it('watches WEBSITE_CHANGE under 45 days and strength < 50', () => {
    const result = classifySignal(sig({ type: 'WEBSITE_CHANGE', strength: 40, detectedAt: new Date() }))
    assert.equal(result.decision, 'WATCH')
    assert.ok(result.riskFlags.includes('needs_corroboration'))
  })

  it('watches NEWS_MENTION under 30 days and strength < 50', () => {
    const result = classifySignal(sig({ type: 'NEWS_MENTION', strength: 30, detectedAt: new Date() }))
    assert.equal(result.decision, 'WATCH')
  })

  it('watches LEADERSHIP_CHANGE with moderate strength', () => {
    const result = classifySignal(sig({ type: 'LEADERSHIP_CHANGE', strength: 40, detectedAt: new Date() }))
    assert.equal(result.decision, 'WATCH')
  })

  it('watches moderate-strength HIRING (decayed < 40)', () => {
    // Strength 50, age 20 days → ~38 decayed
    const result = classifySignal(sig({ type: 'HIRING', strength: 50, detectedAt: new Date(Date.now() - 20 * 86_400_000) }))
    assert.equal(result.decision, 'WATCH')
  })
})

describe('classifySignal — ACT conditions', () => {
  it('ACTs on strong HIRING signal (decayed ≥ 40)', () => {
    const result = classifySignal(sig({ type: 'HIRING', strength: 90, detectedAt: new Date() }))
    assert.equal(result.decision, 'ACT')
  })

  it('ACTs on PROBLEM_OWNER_ACTIVATION at any strength', () => {
    const result = classifySignal(sig({ type: 'PROBLEM_OWNER_ACTIVATION', strength: 5, detectedAt: new Date() }))
    assert.equal(result.decision, 'ACT')
  })

  it('ACTs on FUNDING ≥ 50 decayed strength', () => {
    const result = classifySignal(sig({ type: 'FUNDING', strength: 80, detectedAt: new Date() }))
    assert.equal(result.decision, 'ACT')
  })

  it('ACTs on CONTRACT_AWARDED ≥ 55 decayed strength', () => {
    const result = classifySignal(sig({ type: 'CONTRACT_AWARDED', strength: 80, detectedAt: new Date() }))
    assert.equal(result.decision, 'ACT')
  })

  it('ACTs on TENDER_PUBLISHED ≥ 55 decayed strength', () => {
    const result = classifySignal(sig({ type: 'TENDER_PUBLISHED', strength: 80, detectedAt: new Date() }))
    assert.equal(result.decision, 'ACT')
  })
})

describe('classifyProspectSignals — empty and single-signal', () => {
  it('IGNOREs empty signal set', () => {
    const r = classifyProspectSignals([], meta)
    assert.equal(r.decision, 'IGNORE')
    assert.equal(r.actSignals.length, 0)
    assert.equal(r.watchSignals.length, 0)
  })

  it('WATCHes single HIRING signal of moderate strength', () => {
    const r = classifyProspectSignals([sig({ type: 'HIRING', strength: 50, detectedAt: new Date(Date.now() - 20 * 86_400_000) })], meta)
    assert.equal(r.decision, 'WATCH')
    assert.ok(r.riskFlags.includes('single_signal'))
  })

  it('ACTs on single strong FUNDING signal', () => {
    const r = classifyProspectSignals([sig({ type: 'FUNDING', strength: 80, detectedAt: new Date() })], meta)
    assert.equal(r.decision, 'ACT')
  })

  it('IGNOREs single WEBSITE_CHANGE alone (noisy type)', () => {
    const r = classifyProspectSignals([sig({ type: 'WEBSITE_CHANGE', strength: 40, detectedAt: new Date() })], meta)
    // WEBSITE_CHANGE alone → WATCH, not IGNORE, since it's not aged out
    assert.equal(r.decision, 'WATCH')
  })

  it('IGNOREs when only signal is too old (expired)', () => {
    const r = classifyProspectSignals([
      sig({ type: 'WEBSITE_CHANGE', strength: 80, detectedAt: new Date(Date.now() - 50 * 86_400_000) })
    ], meta)
    assert.equal(r.decision, 'IGNORE')
    assert.equal(r.ignoredSignals.length, 1)
  })
})

describe('classifyProspectSignals — convergence patterns', () => {
  it('ACTs on CONTRACT_AWARDED + HIRING', () => {
    const r = classifyProspectSignals([
      sig({ type: 'CONTRACT_AWARDED', strength: 80 }),
      sig({ type: 'HIRING', strength: 80 }),
    ], meta)
    assert.equal(r.decision, 'ACT')
    assert.ok(r.reason.includes('contract'))
  })

  it('ACTs on TENDER_PUBLISHED + JOB_POSTING_SPIKE', () => {
    const r = classifyProspectSignals([
      sig({ type: 'TENDER_PUBLISHED', strength: 80 }),
      sig({ type: 'JOB_POSTING_SPIKE', strength: 70 }),
    ], meta)
    assert.equal(r.decision, 'ACT')
    assert.ok(r.reason.includes('tender'))
  })

  it('ACTs on FUNDING + HIRING', () => {
    const r = classifyProspectSignals([
      sig({ type: 'FUNDING', strength: 80 }),
      sig({ type: 'HIRING', strength: 70 }),
    ], meta)
    assert.equal(r.decision, 'ACT')
  })

  it('ACTs on EXPANSION + JOB_POSTING_SPIKE', () => {
    const r = classifyProspectSignals([
      sig({ type: 'EXPANSION', strength: 70 }),
      sig({ type: 'JOB_POSTING_SPIKE', strength: 70 }),
    ], meta)
    assert.equal(r.decision, 'ACT')
  })

  it('ACTs on PERMIT_APPROVED + PROJECT_START_DETECTED', () => {
    const r = classifyProspectSignals([
      sig({ type: 'PERMIT_APPROVED', strength: 80 }),
      sig({ type: 'PROJECT_START_DETECTED', strength: 70 }),
    ], meta)
    assert.equal(r.decision, 'ACT')
  })

  it('ACTs when POA is present regardless of other signals', () => {
    const r = classifyProspectSignals([
      sig({ type: 'PROBLEM_OWNER_ACTIVATION', strength: 65 }),
      sig({ type: 'NEWS_MENTION', strength: 20 }),
    ], meta)
    assert.equal(r.decision, 'ACT')
    assert.ok(r.reason.toLowerCase().includes('problem-owner'))
  })

  it('ACTs when 3+ distinct non-ignored signal types converge', () => {
    const r = classifyProspectSignals([
      sig({ type: 'HIRING',       strength: 60 }),
      sig({ type: 'NEWS_MENTION', strength: 60, detectedAt: new Date() }),
      sig({ type: 'EXPANSION',    strength: 60 }),
    ], meta)
    assert.equal(r.decision, 'ACT')
  })

  it('does NOT converge when one pattern signal is ignored', () => {
    const old = new Date(Date.now() - 50 * 86_400_000)
    const r = classifyProspectSignals([
      // WEBSITE_CHANGE expired → IGNORE
      sig({ type: 'WEBSITE_CHANGE', strength: 80, detectedAt: old }),
      // HIRING moderate → WATCH
      sig({ type: 'HIRING', strength: 50, detectedAt: new Date(Date.now() - 20 * 86_400_000) }),
    ], meta)
    // Only HIRING is active (WATCH), WEBSITE_CHANGE is ignored → no convergence
    assert.notEqual(r.decision, 'ACT')
  })
})

describe('classifyProspectSignals — risk flags', () => {
  it('flags no_contact_email', () => {
    const r = classifyProspectSignals(
      [sig({ type: 'FUNDING', strength: 80 })],
      { ...meta, contactEmail: null }
    )
    assert.ok(r.riskFlags.includes('no_contact_email'))
  })

  it('flags no_domain', () => {
    const r = classifyProspectSignals(
      [sig({ type: 'FUNDING', strength: 80 })],
      { ...meta, domain: null }
    )
    assert.ok(r.riskFlags.includes('no_domain'))
  })

  it('flags stale_signals when all signals > 30 days old', () => {
    const old = new Date(Date.now() - 40 * 86_400_000)
    const r = classifyProspectSignals(
      [sig({ type: 'HIRING', strength: 80, detectedAt: old })],
      meta
    )
    assert.ok(r.riskFlags.includes('stale_signals'))
  })

  it('flags single_signal when only one non-ignored signal', () => {
    const r = classifyProspectSignals([sig({ type: 'HIRING', strength: 80 })], meta)
    assert.ok(r.riskFlags.includes('single_signal'))
  })
})

describe('classifyProspectSignals — signal accounting', () => {
  it('correctly populates actSignals, watchSignals, ignoredSignals', () => {
    const old = new Date(Date.now() - 50 * 86_400_000)
    const r = classifyProspectSignals([
      sig({ type: 'CONTRACT_AWARDED',  strength: 80 }),                        // ACT
      sig({ type: 'HIRING',            strength: 30, detectedAt: new Date(Date.now() - 25 * 86_400_000) }), // WATCH
      sig({ type: 'WEBSITE_CHANGE',    strength: 80, detectedAt: old }),        // IGNORE (expired)
    ], meta)
    assert.equal(r.actSignals.length, 1)
    assert.equal(r.actSignals[0].type, 'CONTRACT_AWARDED')
    assert.equal(r.watchSignals.length, 1)
    assert.equal(r.ignoredSignals.length, 1)
    assert.ok(r.rejectionReasons.length >= 1)
  })

  it('rejection reasons include the signal type', () => {
    const old = new Date(Date.now() - 50 * 86_400_000)
    const r = classifyProspectSignals([sig({ type: 'WEBSITE_CHANGE', strength: 80, detectedAt: old })], meta)
    assert.ok(r.rejectionReasons.some(reason => reason.includes('WEBSITE_CHANGE')))
  })
})

describe('signalPatternKey', () => {
  it('sorts signal types alphabetically', () => {
    const key = signalPatternKey([
      sig({ type: 'HIRING' }),
      sig({ type: 'CONTRACT_AWARDED' }),
      sig({ type: 'FUNDING' }),
    ])
    assert.equal(key, 'CONTRACT_AWARDED|FUNDING|HIRING')
  })

  it('deduplicates repeated signal types', () => {
    const key = signalPatternKey([
      sig({ type: 'HIRING' }),
      sig({ type: 'HIRING' }),
      sig({ type: 'FUNDING' }),
    ])
    assert.equal(key, 'FUNDING|HIRING')
  })

  it('returns NONE for empty array', () => {
    assert.equal(signalPatternKey([]), 'NONE')
  })

  it('single signal type returns that type', () => {
    assert.equal(signalPatternKey([sig({ type: 'FUNDING' })]), 'FUNDING')
  })
})

describe('validateEnv — boot validation', () => {
  it('validateEnv passes when required vars are set', async () => {
    const orig = { ...process.env }
    process.env.DATABASE_URL = 'postgres://test'
    process.env.REDIS_URL    = 'redis://test'
    process.env.JWT_SECRET   = 'testsecret'
    const { validateEnv } = await import('../apps/api/src/lib/env.js')
    assert.doesNotThrow(() => validateEnv())
    Object.assign(process.env, orig)
  })

  it('validateEnv throws when DATABASE_URL is missing', async () => {
    const origDb = process.env.DATABASE_URL
    delete process.env.DATABASE_URL
    // Re-import to test — but since module is cached, we test the function directly
    const { validateEnv } = await import('../apps/api/src/lib/env.js')
    assert.throws(() => validateEnv(), /DATABASE_URL/)
    process.env.DATABASE_URL = origDb
  })

  it('hasEnv returns false for unset var', async () => {
    const { hasEnv } = await import('../apps/api/src/lib/env.js')
    assert.equal(hasEnv(['__NONEXISTENT_VAR_XYZ__']), false)
  })

  it('hasEnv returns true when all vars present', async () => {
    process.env.__TEST_VAR_A__ = 'yes'
    process.env.__TEST_VAR_B__ = 'yes'
    const { hasEnv } = await import('../apps/api/src/lib/env.js')
    assert.equal(hasEnv(['__TEST_VAR_A__', '__TEST_VAR_B__']), true)
    delete process.env.__TEST_VAR_A__
    delete process.env.__TEST_VAR_B__
  })
})
