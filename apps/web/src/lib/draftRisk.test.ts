import { describe, test, expect } from 'vitest'
import { analyzeDraft } from './draftRisk.js'

const cleanBody =
  'Hi there — I noticed your team is hiring field technicians. We help trades teams book more jobs. ' +
  'Open to a quick chat next week? Reply STOP to unsubscribe.'

describe('analyzeDraft', () => {
  test('a well-formed compliant draft has no risks', () => {
    expect(analyzeDraft('Quick question about your field team', cleanBody)).toEqual([])
  })

  test('flags an unresolved merge placeholder', () => {
    const risks = analyzeDraft('Hi {{firstName}}', cleanBody)
    expect(risks.map(r => r.id)).toContain('placeholder')
  })

  test('flags a missing subject and a too-short body as warnings', () => {
    const risks = analyzeDraft('', 'hey')
    const byId = Object.fromEntries(risks.map(r => [r.id, r]))
    expect(byId['no-subject']?.level).toBe('warn')
    expect(byId['too-short']?.level).toBe('warn')
  })

  test('flags missing opt-out language', () => {
    const risks = analyzeDraft('Hello', 'A perfectly reasonable message with enough length to pass the short check.')
    expect(risks.map(r => r.id)).toContain('no-optout')
  })

  test('flags spam-trigger phrasing and all-caps subjects', () => {
    const risks = analyzeDraft('ACT NOW', 'Click here for a risk-free guarantee. Reply STOP to unsubscribe.')
    const ids = risks.map(r => r.id)
    expect(ids).toContain('spam-words')
    expect(ids).toContain('caps-subject')
  })

  test('flags excessive exclamation marks', () => {
    const risks = analyzeDraft('Great news', 'This is amazing!!! You will love it!! Reply STOP to unsubscribe and read more.')
    expect(risks.map(r => r.id)).toContain('exclamations')
  })
})
