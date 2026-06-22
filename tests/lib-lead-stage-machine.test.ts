import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { transitionLeadStage, type LeadStageEvent } from '../packages/backend-core/src/services/leadStageMachine.ts'
import type { LeadStage } from '../packages/shared/src/index.ts'

describe('transitionLeadStage — forward pipeline progression', () => {
  it('advances NEW/RESEARCHED to OUTREACH_SENT on send', () => {
    assert.deepEqual(transitionLeadStage('NEW', 'OUTREACH_SENT').nextStage, 'OUTREACH_SENT')
    const t = transitionLeadStage('RESEARCHED', 'OUTREACH_SENT')
    assert.equal(t.nextStage, 'OUTREACH_SENT')
    assert.equal(t.changed, true)
  })

  it('advances OUTREACH_SENT to REPLIED on a reply (interested or not)', () => {
    assert.equal(transitionLeadStage('OUTREACH_SENT', 'REPLY_INTERESTED').nextStage, 'REPLIED')
    assert.equal(transitionLeadStage('OUTREACH_SENT', 'REPLY_NOT_INTERESTED').nextStage, 'REPLIED')
  })

  it('advances REPLIED to BOOKED, and BOOKED to CLOSED', () => {
    assert.equal(transitionLeadStage('REPLIED', 'BOOK_MEETING').nextStage, 'BOOKED')
    assert.equal(transitionLeadStage('BOOKED', 'MARK_CLOSED').nextStage, 'CLOSED')
  })
})

describe('transitionLeadStage — no regression', () => {
  it('does not pull BOOKED back to REPLIED on a late reply', () => {
    const t = transitionLeadStage('BOOKED', 'REPLY_INTERESTED')
    assert.equal(t.nextStage, 'BOOKED')
    assert.equal(t.changed, false)
  })

  it('is idempotent: OUTREACH_SENT on an already-sent lead does not change', () => {
    const t = transitionLeadStage('OUTREACH_SENT', 'OUTREACH_SENT')
    assert.equal(t.changed, false)
    assert.equal(t.nextStage, 'OUTREACH_SENT')
  })

  it('does not move REPLIED back to OUTREACH_SENT', () => {
    assert.equal(transitionLeadStage('REPLIED', 'OUTREACH_SENT').changed, false)
  })
})

describe('transitionLeadStage — terminating events', () => {
  it('bounce and unsubscribe move any non-terminal lead to DEAD', () => {
    for (const stage of ['NEW', 'RESEARCHED', 'OUTREACH_SENT', 'REPLIED', 'BOOKED'] as LeadStage[]) {
      assert.equal(transitionLeadStage(stage, 'BOUNCE').nextStage, 'DEAD', `${stage} bounce`)
      assert.equal(transitionLeadStage(stage, 'UNSUBSCRIBE').nextStage, 'DEAD', `${stage} unsub`)
    }
  })

  it('MARK_CLOSED / MARK_DEAD apply from any non-terminal stage', () => {
    assert.equal(transitionLeadStage('OUTREACH_SENT', 'MARK_CLOSED').nextStage, 'CLOSED')
    assert.equal(transitionLeadStage('REPLIED', 'MARK_DEAD').nextStage, 'DEAD')
  })
})

describe('transitionLeadStage — terminal stages are immovable', () => {
  it('CLOSED does not transition on any event', () => {
    const events: LeadStageEvent[] = ['OUTREACH_SENT', 'REPLY_INTERESTED', 'BOUNCE', 'MARK_DEAD', 'BOOK_MEETING']
    for (const e of events) {
      const t = transitionLeadStage('CLOSED', e)
      assert.equal(t.changed, false, `CLOSED + ${e}`)
      assert.equal(t.nextStage, 'CLOSED')
    }
  })

  it('DEAD does not transition on any event (manual reopen only)', () => {
    const events: LeadStageEvent[] = ['OUTREACH_SENT', 'REPLY_INTERESTED', 'BOOK_MEETING', 'MARK_CLOSED']
    for (const e of events) {
      assert.equal(transitionLeadStage('DEAD', e).changed, false, `DEAD + ${e}`)
    }
  })
})

describe('transitionLeadStage — always reports a reason', () => {
  it('includes a human-readable reason on both change and no-op', () => {
    assert.match(transitionLeadStage('NEW', 'OUTREACH_SENT').reason, /OUTREACH_SENT/)
    assert.match(transitionLeadStage('BOOKED', 'REPLY_INTERESTED').reason, /no-op/)
    assert.match(transitionLeadStage('CLOSED', 'BOUNCE').reason, /terminal/)
  })
})
