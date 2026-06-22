import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { checkDraftPolicy, formatViolations, countLinks } from '../packages/backend-core/src/lib/policyCheck.ts'

// A compliant body reused across cases: long enough, has an unsubscribe notice,
// no risky language. Individual cases override subject/body to exercise one rule.
const GOOD_BODY =
  'I noticed you work in commercial HVAC and thought our scheduling tool might help. ' +
  'Happy to share more if useful. You can unsubscribe any time.'

describe('checkDraftPolicy — subject length', () => {
  it('rejects a subject below the minimum', () => {
    const violations = checkDraftPolicy({ subject: 'hi', emailBody: GOOD_BODY }, { minSubjectLength: 5 })
    assert.ok(violations.some(v => v.code === 'SUBJECT_TOO_SHORT'))
  })

  it('rejects a subject above the maximum', () => {
    const violations = checkDraftPolicy({ subject: 'A'.repeat(100), emailBody: GOOD_BODY }, { maxSubjectLength: 80 })
    assert.ok(violations.some(v => v.code === 'SUBJECT_TOO_LONG'))
  })

  it('accepts a subject within range', () => {
    const violations = checkDraftPolicy(
      { subject: 'Check out this product', emailBody: GOOD_BODY },
      { minSubjectLength: 5, maxSubjectLength: 100 }
    )
    assert.equal(violations.filter(v => v.code.startsWith('SUBJECT')).length, 0)
  })
})

describe('checkDraftPolicy — body length', () => {
  it('rejects a body below the minimum', () => {
    const violations = checkDraftPolicy({ subject: 'Good Subject Line', emailBody: 'too short' }, { minBodyLength: 30 })
    assert.ok(violations.some(v => v.code === 'BODY_TOO_SHORT'))
  })

  it('rejects a body above the maximum', () => {
    const violations = checkDraftPolicy({ subject: 'Good Subject Line', emailBody: 'A'.repeat(5000) }, { maxBodyLength: 3000 })
    assert.ok(violations.some(v => v.code === 'BODY_TOO_LONG'))
  })
})

describe('checkDraftPolicy — forbidden phrases', () => {
  it('detects a forbidden phrase case-insensitively', () => {
    const violations = checkDraftPolicy(
      { subject: 'Opportunity', emailBody: 'This is a GUARANTEED win. Unsubscribe here.' },
      { forbiddenPhrases: ['guaranteed'] }
    )
    assert.ok(violations.some(v => v.code === 'FORBIDDEN_PHRASE'))
  })

  it('passes when no forbidden phrase is present', () => {
    const violations = checkDraftPolicy(
      { subject: 'Opportunity', emailBody: GOOD_BODY },
      { forbiddenPhrases: ['viagra', 'lottery'] }
    )
    assert.equal(violations.filter(v => v.code === 'FORBIDDEN_PHRASE').length, 0)
  })
})

describe('checkDraftPolicy — unsubscribe compliance (opt-in)', () => {
  it('does NOT flag a missing unsubscribe by default (footer guarantees it)', () => {
    const violations = checkDraftPolicy({ subject: 'Product Update', emailBody: 'Check out our new features today!' })
    assert.ok(!violations.some(v => v.code === 'MISSING_UNSUBSCRIBE'))
  })

  it('flags a missing unsubscribe only when explicitly required', () => {
    const violations = checkDraftPolicy(
      { subject: 'Product Update', emailBody: 'Check out our new features today!' },
      { requireUnsubscribeInBody: true }
    )
    assert.ok(violations.some(v => v.code === 'MISSING_UNSUBSCRIBE'))
  })

  it('passes when an unsubscribe notice is present and required', () => {
    const violations = checkDraftPolicy(
      { subject: 'Product Update', emailBody: GOOD_BODY },
      { requireUnsubscribeInBody: true }
    )
    assert.ok(!violations.some(v => v.code === 'MISSING_UNSUBSCRIBE'))
  })
})

describe('checkDraftPolicy — risky language', () => {
  it('flags guarantee-style language', () => {
    const violations = checkDraftPolicy({
      subject: 'Results',
      emailBody: 'Our product is 100% guaranteed to grow revenue. Unsubscribe here.'
    })
    assert.ok(violations.some(v => v.code === 'RISKY_LANGUAGE'))
  })

  it('allows reasonable, hedged claims', () => {
    const violations = checkDraftPolicy({
      subject: 'Opportunity',
      emailBody: 'Our clients have seen improvements in their processes. Unsubscribe here.'
    })
    assert.ok(!violations.some(v => v.code === 'RISKY_LANGUAGE'))
  })
})

describe('checkDraftPolicy — link count', () => {
  it('counts http(s) links in a body', () => {
    assert.equal(countLinks('see https://a.test and http://b.test/x'), 2)
    assert.equal(countLinks('no links here'), 0)
  })

  it('flags a link-stuffed body as TOO_MANY_LINKS', () => {
    const body = 'Deals: ' + Array.from({ length: 10 }, (_, i) => `https://promo${i}.test/x`).join(' ') + ' Unsubscribe here.'
    const violations = checkDraftPolicy({ subject: 'Great deals for you', emailBody: body })
    assert.ok(violations.some(v => v.code === 'TOO_MANY_LINKS'))
  })

  it('does not flag normal outreach with a couple of links', () => {
    const body = 'Saw your work — here is our site https://acme.test and a case study https://acme.test/case. Unsubscribe here.'
    const violations = checkDraftPolicy({ subject: 'Quick question', emailBody: body })
    assert.ok(!violations.some(v => v.code === 'TOO_MANY_LINKS'))
  })

  it('respects an explicit maxLinks override and can be disabled with 0', () => {
    const body = 'a https://1.test b https://2.test c https://3.test'
    assert.ok(checkDraftPolicy({ subject: 'Three links here', emailBody: body }, { maxLinks: 2 }).some(v => v.code === 'TOO_MANY_LINKS'))
    assert.ok(!checkDraftPolicy({ subject: 'Three links here', emailBody: body }, { maxLinks: 0 }).some(v => v.code === 'TOO_MANY_LINKS'))
  })
})

describe('formatViolations', () => {
  it('renders code and message for each violation', () => {
    const formatted = formatViolations([
      { code: 'SUBJECT_TOO_SHORT', message: 'Subject line is too short' },
      { code: 'MISSING_UNSUBSCRIBE', message: 'Email body must include an unsubscribe link' }
    ])
    assert.ok(formatted.includes('SUBJECT_TOO_SHORT'))
    assert.ok(formatted.includes('MISSING_UNSUBSCRIBE'))
  })

  it('returns an empty string for no violations', () => {
    assert.equal(formatViolations([]), '')
  })
})
