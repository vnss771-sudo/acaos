// Held-back comparison group (holdout) for measuring whether learning helps.
//
// A small, random share of leads is set aside and never contacted by campaign
// runs. Because membership is random — a hash of workspace + lead, independent
// of score, industry or anything learning touches — the held-out group is a
// fair baseline: comparing its outcomes with the contacted group's outcomes
// shows the lift outreach (and, over time, learning-driven outreach) delivers.
//
// Assignment is deterministic, so a held-out lead stays held out on every run
// for as long as the share is unchanged (no leakage into the treated group).
// Each run stores the share in force in its selection totals, and each
// held-out lead is recorded as a HELD_OUT selection with that run.

import { createHash } from 'node:crypto'
import { prisma } from './prisma.js'
import { learningAdaptationMode } from './learningMode.js'

/** Hard ceiling: a holdout is a measurement tool, never a way to stop sending. */
export const MAX_HOLDOUT_PERCENT = 20
/** Share held out when learning is `live` and no explicit share is set. */
export const DEFAULT_LIVE_HOLDOUT_PERCENT = 5

/**
 * Percent of leads to hold out, from LEARNING_HOLDOUT_PERCENT (0–20, decimals
 * allowed). Unset: 5% when learning is `live` (learning must be measurable
 * once it changes behaviour), otherwise 0 (no holdout, nothing changes).
 */
export function holdoutPercent(): number {
  const raw = (process.env.LEARNING_HOLDOUT_PERCENT ?? '').trim()
  if (raw === '') return learningAdaptationMode() === 'live' ? DEFAULT_LIVE_HOLDOUT_PERCENT : 0
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(n, MAX_HOLDOUT_PERCENT)
}

/** Stable bucket in [0, 100) for a lead; uniform and independent of lead data. */
export function holdoutBucket(workspaceId: string, leadId: string): number {
  const h = createHash('sha256').update(`holdout:v1:${workspaceId}:${leadId}`).digest()
  return (h.readUInt32BE(0) / 0x1_0000_0000) * 100
}

export function isHeldOut(workspaceId: string, leadId: string, percent: number): boolean {
  return percent > 0 && holdoutBucket(workspaceId, leadId) < percent
}

export type GroupStats = { leads: number; replied: number; converted: number; replyRate: number; conversionRate: number }
export type HoldoutComparison = {
  holdoutPercent: number
  contacted: GroupStats
  heldOut: GroupStats
  /** Converted-rate difference (contacted − held out), in percentage points; null until both groups have leads. */
  conversionLiftPts: number | null
}

const REPLIED_STAGES = new Set(['REPLIED', 'BOOKED', 'CLOSED'])
const CONVERTED_STAGES = new Set(['BOOKED', 'CLOSED'])

function stats(stages: string[]): GroupStats {
  const leads = stages.length
  const replied = stages.filter(s => REPLIED_STAGES.has(s)).length
  const converted = stages.filter(s => CONVERTED_STAGES.has(s)).length
  const rate = (n: number) => (leads ? Math.round((n / leads) * 1000) / 10 : 0)
  return { leads, replied, converted, replyRate: rate(replied), conversionRate: rate(converted) }
}

/**
 * Contacted vs held-out outcomes for a workspace, from the selection records.
 * A lead counts in the held-out group only if it was never contacted by any
 * run; outcome is the lead's current stage (replied = REPLIED/BOOKED/CLOSED,
 * converted = BOOKED/CLOSED).
 */
export async function compareHoldout(workspaceId: string): Promise<HoldoutComparison> {
  const [contactedRows, heldRows] = await Promise.all([
    prisma.outreachSelection.findMany({ where: { workspaceId, decision: 'SELECTED' }, select: { leadId: true }, distinct: ['leadId'] }),
    prisma.outreachSelection.findMany({ where: { workspaceId, decision: 'HELD_OUT' }, select: { leadId: true }, distinct: ['leadId'] }),
  ])
  const contactedIds = new Set(contactedRows.map((r: { leadId: string }) => r.leadId))
  const heldIds = heldRows.map((r: { leadId: string }) => r.leadId).filter((id: string) => !contactedIds.has(id))
  const leads = await prisma.lead.findMany({
    where: { workspaceId, id: { in: [...contactedIds, ...heldIds] } },
    select: { id: true, stage: true },
  })
  const stageOf = new Map(leads.map((l: { id: string; stage: string }) => [l.id, l.stage]))
  const pick = (ids: Iterable<string>) => [...ids].map(id => stageOf.get(id)).filter((s): s is string => !!s)
  const contacted = stats(pick(contactedIds))
  const heldOut = stats(pick(heldIds))
  return {
    holdoutPercent: holdoutPercent(),
    contacted,
    heldOut,
    conversionLiftPts: contacted.leads && heldOut.leads ? Math.round((contacted.conversionRate - heldOut.conversionRate) * 10) / 10 : null,
  }
}
