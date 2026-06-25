import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { computeAttributionRates, getCampaignAttribution } from '../packages/backend-core/src/lib/campaignAttribution.ts'
import { createFakePrisma, installPrisma, resetPrisma } from './helpers/integration.ts'

afterEach(() => resetPrisma())

test('computeAttributionRates derives conversion relative to contacted, guarding div-by-zero', () => {
  assert.deepEqual(computeAttributionRates({ sent: 100, replied: 25, booked: 10, won: 4 }), {
    replyRate: 0.25, meetingRate: 0.1, winRate: 0.04,
  })
  // Nothing sent → all-zero, not NaN.
  assert.deepEqual(computeAttributionRates({ sent: 0, replied: 0, booked: 0, won: 0 }), {
    replyRate: 0, meetingRate: 0, winRate: 0,
  })
})

test('getCampaignAttribution counts distinct leads from the ledger and booked/won from lead stage', async () => {
  // Ledger: 3 distinct leads SENT, 2 distinct REPLIED (one lead replied twice).
  const ledger: Record<string, Array<{ leadId: string }>> = {
    SENT: [{ leadId: 'l1' }, { leadId: 'l2' }, { leadId: 'l3' }],
    REPLIED: [{ leadId: 'l1' }, { leadId: 'l2' }],
  }
  installPrisma(createFakePrisma({
    contactEvent: {
      // distinct:['leadId'] is honored by the real client; the fake returns the
      // already-distinct fixture so the count reflects distinct leads.
      findMany: async (a: any) => ledger[a.where.type] ?? [],
    },
    lead: {
      // booked = stage in [BOOKED, CLOSED] → 2; won = CLOSED → 1.
      count: async (a: any) => {
        const stages: string[] = a.where.stage.in
        if (stages.includes('BOOKED')) return 2
        return 1 // CLOSED only
      },
    },
  }))

  const attr = await getCampaignAttribution('c1')
  assert.equal(attr.sent, 3)
  assert.equal(attr.replied, 2)
  assert.equal(attr.booked, 2)
  assert.equal(attr.won, 1)
  assert.equal(attr.replyRate, 0.667) // 2/3
  assert.equal(attr.meetingRate, 0.667) // 2/3
  assert.equal(attr.winRate, 0.333) // 1/3
})
