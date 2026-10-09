import { describe, test, expect } from 'vitest'
import { quoteLifecycleCue } from './QuoteCapture'

describe('quoteLifecycleCue', () => {
  test('follows persisted quote and job state only', () => {
    expect(quoteLifecycleCue({ status: 'SUBMITTED', job: null })).toBe('Opportunity → quote sent → awaiting decision')
    expect(quoteLifecycleCue({ status: 'ACCEPTED', job: null })).toBe('Opportunity → quote → won → ready to start')
    expect(quoteLifecycleCue({ status: 'ACCEPTED', job: { id: 'j1', status: 'ACTIVE' } })).toBe('Opportunity → quote → won → job in delivery')
    expect(quoteLifecycleCue({ status: 'ACCEPTED', job: { id: 'j1', status: 'COMPLETE' } })).toBe('Opportunity → quote → won → job complete')
    expect(quoteLifecycleCue({ status: 'ACCEPTED', job: { id: 'j1', status: 'CANCELLED' } })).toBe('Opportunity → quote → won → job cancelled')
  })

  test('has no cue for drafts or closed-out quotes', () => {
    for (const status of ['DRAFT', 'REJECTED', 'WITHDRAWN'] as const) expect(quoteLifecycleCue({ status, job: null })).toBeNull()
  })
})
