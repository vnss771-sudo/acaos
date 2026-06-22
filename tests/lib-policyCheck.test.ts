import { describe, it, expect } from 'vitest'
import { checkDraftPolicy, formatViolations } from '@acaos/backend-core/lib/policyCheck'

describe('Draft Policy Checks', () => {
  describe('Subject length validation', () => {
    it('rejects subject that is too short', () => {
      const draft = { subject: 'hi', emailBody: 'This is a nice long email body with many words to satisfy the minimum length requirement and more text here.' }
      const violations = checkDraftPolicy(draft, { minSubjectLength: 5 })
      expect(violations.some(v => v.code === 'SUBJECT_TOO_SHORT')).toBe(true)
    })

    it('rejects subject that is too long', () => {
      const draft = {
        subject: 'A'.repeat(100),
        emailBody: 'This is a nice long email body with many words to satisfy the minimum length requirement and more text here.'
      }
      const violations = checkDraftPolicy(draft, { maxSubjectLength: 80 })
      expect(violations.some(v => v.code === 'SUBJECT_TOO_LONG')).toBe(true)
    })

    it('allows subject within acceptable range', () => {
      const draft = {
        subject: 'Check out this cool product',
        emailBody: 'This is a nice long email body with many words to satisfy the minimum length requirement and more text here.'
      }
      const violations = checkDraftPolicy(draft, {
        minSubjectLength: 5,
        maxSubjectLength: 100
      })
      expect(violations.filter(v => v.code.includes('SUBJECT'))).toHaveLength(0)
    })
  })

  describe('Body length validation', () => {
    it('rejects body that is too short', () => {
      const draft = {
        subject: 'Good Subject Line Here',
        emailBody: 'Too short'
      }
      const violations = checkDraftPolicy(draft, { minBodyLength: 30 })
      expect(violations.some(v => v.code === 'BODY_TOO_SHORT')).toBe(true)
    })

    it('rejects body that is too long', () => {
      const draft = {
        subject: 'Good Subject Line Here',
        emailBody: 'A'.repeat(5000)
      }
      const violations = checkDraftPolicy(draft, { maxBodyLength: 3000 })
      expect(violations.some(v => v.code === 'BODY_TOO_LONG')).toBe(true)
    })
  })

  describe('Forbidden phrases', () => {
    it('detects forbidden phrases (case-insensitive)', () => {
      const draft = {
        subject: 'Opportunity',
        emailBody: 'This is a GUARANTEED way to make money fast'
      }
      const violations = checkDraftPolicy(draft, {
        forbiddenPhrases: ['guaranteed', 'make money']
      })
      expect(violations.some(v => v.code === 'FORBIDDEN_PHRASE')).toBe(true)
    })

    it('allows content without forbidden phrases', () => {
      const draft = {
        subject: 'Opportunity',
        emailBody: 'I noticed you work in tech and might be interested in our service. Let me know if you want to chat!'
      }
      const violations = checkDraftPolicy(draft, {
        forbiddenPhrases: ['guaranteed', 'make money']
      })
      expect(violations.filter(v => v.code === 'FORBIDDEN_PHRASE')).toHaveLength(0)
    })
  })

  describe('Unsubscribe compliance', () => {
    it('flags emails without unsubscribe mention', () => {
      const draft = {
        subject: 'Product Update',
        emailBody: 'Check out our new features!'
      }
      const violations = checkDraftPolicy(draft)
      expect(violations.some(v => v.code === 'MISSING_UNSUBSCRIBE')).toBe(true)
    })

    it('passes with unsubscribe link', () => {
      const draft = {
        subject: 'Product Update',
        emailBody: 'Check out our new features! Click here to unsubscribe.'
      }
      const violations = checkDraftPolicy(draft)
      expect(violations.some(v => v.code === 'MISSING_UNSUBSCRIBE')).toBe(false)
    })
  })

  describe('Risky language detection', () => {
    it('flags guarantees', () => {
      const draft = {
        subject: 'Guaranteed Results',
        emailBody: 'Our product is 100% guaranteed to increase your revenue by 50% or your money back'
      }
      const violations = checkDraftPolicy(draft)
      expect(violations.some(v => v.code === 'RISKY_LANGUAGE')).toBe(true)
    })

    it('allows reasonable claims', () => {
      const draft = {
        subject: 'Opportunity',
        emailBody: 'Our clients have seen improvements in their processes. Unsubscribe here.'
      }
      const violations = checkDraftPolicy(draft)
      expect(violations.some(v => v.code === 'RISKY_LANGUAGE')).toBe(false)
    })
  })

  describe('Formatting and reporting', () => {
    it('formats violations clearly', () => {
      const violations = [
        { code: 'SUBJECT_TOO_SHORT', message: 'Subject line is too short' },
        { code: 'MISSING_UNSUBSCRIBE', message: 'Email body must include an unsubscribe link' }
      ]
      const formatted = formatViolations(violations)
      expect(formatted).toContain('SUBJECT_TOO_SHORT')
      expect(formatted).toContain('MISSING_UNSUBSCRIBE')
    })

    it('returns empty string when no violations', () => {
      const formatted = formatViolations([])
      expect(formatted).toBe('')
    })
  })
})
