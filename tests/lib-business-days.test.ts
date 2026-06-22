import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { businessDaysBefore } from '../packages/backend-core/src/services/contactPolicy.ts'

describe('businessDaysBefore', () => {
  it('returns the same instant for n=0', () => {
    const d = new Date('2026-06-17T10:00:00Z') // Wednesday
    assert.equal(businessDaysBefore(d, 0).getTime(), d.getTime())
  })

  it('steps back simple weekdays', () => {
    // Wednesday minus 2 business days = Monday
    const wed = new Date('2026-06-17T10:00:00Z')
    const res = businessDaysBefore(wed, 2)
    assert.equal(res.getUTCDate(), 15) // Mon Jun 15
  })

  it('skips the weekend', () => {
    // Monday minus 1 business day = previous Friday (skips Sun/Sat)
    const mon = new Date('2026-06-15T10:00:00Z')
    const res = businessDaysBefore(mon, 1)
    assert.equal(res.getUTCDate(), 12) // Fri Jun 12
  })

  it('spans a weekend for a 5-business-day gap', () => {
    // Wednesday minus 5 business days lands on the previous Wednesday.
    const wed = new Date('2026-06-17T10:00:00Z')
    const res = businessDaysBefore(wed, 5)
    assert.equal(res.getUTCDate(), 10) // Wed Jun 10
  })
})
