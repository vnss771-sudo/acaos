import { prisma } from './prisma.js'
import type { Prisma, PrismaClient } from '@prisma/client'
import type { LeadStage } from '@acaos/shared'

// Campaign ROI / closed-won attribution.
//
// Source-of-truth is chosen per metric to avoid drop-loss:
//   - sent / replied come from the immutable ContactEvent LEDGER (distinct leads
//     with a SENT / REPLIED event for the campaign). A lead that replies and is
//     later marked NOT_INTERESTED → DEAD still keeps its SENT/REPLIED ledger rows,
//     so counting current Lead.stage would *undercount* engagement — the ledger
//     does not.
//   - booked / won come from Lead.stage, the correct source for those sticky
//     positive outcomes (a lead at BOOKED/CLOSED hasn't regressed). Counted
//     cumulatively: BOOKED counts leads that reached *at least* a booked meeting
//     (stage BOOKED or CLOSED); WON counts CLOSED.

type Db = PrismaClient | Prisma.TransactionClient

export type CampaignAttribution = {
  campaignId: string
  sent: number
  replied: number
  booked: number
  won: number
  // Conversion rates (0–1), each relative to the count contacted.
  replyRate: number
  meetingRate: number
  winRate: number
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000

// Pure: derive conversion rates from the four counts. Guards divide-by-zero (a
// campaign with nothing sent has all-zero rates, not NaN).
export function computeAttributionRates(counts: { sent: number; replied: number; booked: number; won: number }): {
  replyRate: number; meetingRate: number; winRate: number
} {
  const denom = counts.sent
  return {
    replyRate: denom > 0 ? round3(counts.replied / denom) : 0,
    meetingRate: denom > 0 ? round3(counts.booked / denom) : 0,
    winRate: denom > 0 ? round3(counts.won / denom) : 0,
  }
}

// Distinct leads with a ledger event of `type` for the campaign. Uses the
// (workspaceId, campaignId, occurredAt) index; bounded by the campaign's lead count.
async function distinctLeadCount(client: Db, campaignId: string, type: 'SENT' | 'REPLIED'): Promise<number> {
  const rows = await client.contactEvent.findMany({
    where: { campaignId, type, leadId: { not: null } },
    distinct: ['leadId'],
    select: { leadId: true },
  })
  return rows.length
}

const AT_LEAST_BOOKED: LeadStage[] = ['BOOKED', 'CLOSED']
const WON_STAGES: LeadStage[] = ['CLOSED']

// Attribute outcomes back to the campaign that ran the outreach. See the module
// header for the per-metric source-of-truth rationale.
export async function getCampaignAttribution(campaignId: string, client: Db = prisma): Promise<CampaignAttribution> {
  const [sent, replied, booked, won] = await Promise.all([
    distinctLeadCount(client, campaignId, 'SENT'),
    distinctLeadCount(client, campaignId, 'REPLIED'),
    client.lead.count({ where: { campaignId, stage: { in: AT_LEAST_BOOKED } } }),
    client.lead.count({ where: { campaignId, stage: { in: WON_STAGES } } }),
  ])
  return { campaignId, sent, replied, booked, won, ...computeAttributionRates({ sent, replied, booked, won }) }
}
