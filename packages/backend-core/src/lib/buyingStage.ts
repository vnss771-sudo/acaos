// Buying-Stage Intelligence — not "is this a good prospect?" but "where are
// they in the buying process?", and what move fits that stage.
//
//   NO_DETECTABLE_NEED → EMERGING_TRIGGER → PROBLEM_LIKELY → ACTIVE_REQUIREMENT
//     → EVALUATING_SOLUTIONS → BUYING_DECISION → CUSTOMER
//
// Inferred from the commercial events (what is happening at the company) and,
// for the last two stages, from recorded engagement (meeting, proposal, won):
// evidence alone never claims a buyer is deciding. An uncorroborated event can't
// place a company past PROBLEM_LIKELY (gate 1). Deterministic; no model call.
import type { CommercialEventHypothesis, CommercialEventKind } from './commercialEventEngine.js'

export const BUYING_STAGES = [
  'NO_DETECTABLE_NEED', 'EMERGING_TRIGGER', 'PROBLEM_LIKELY', 'ACTIVE_REQUIREMENT',
  'EVALUATING_SOLUTIONS', 'BUYING_DECISION', 'CUSTOMER',
] as const
export type BuyingStageV2 = (typeof BUYING_STAGES)[number]

/** Recorded engagement with the company (Prospect.outcomeStage). */
export type EngagementStage = 'DISCOVERED' | 'VIEWED' | 'CONTACTED' | 'MEETING' | 'PROPOSAL' | 'WON' | 'LOST'

export type StagePlay = {
  /** Whether to sell at all at this stage. */
  stance: 'DONT_CONTACT' | 'NURTURE' | 'QUALIFY' | 'ENGAGE' | 'PROVE' | 'CLOSE' | 'EXPAND'
  move: string
  messageGoal: string
}

export type BuyingStageAssessment = {
  stage: BuyingStageV2
  /** 0..100 — how sure the stage is right. */
  confidence: number
  reasons: string[]
  play: StagePlay
  /** Outreach that asks for business only from ACTIVE_REQUIREMENT on. */
  outreachAppropriate: boolean
}

export const STAGE_PLAYBOOK: Record<BuyingStageV2, StagePlay> = {
  NO_DETECTABLE_NEED: { stance: 'DONT_CONTACT', move: 'Don\'t contact — monitor for a trigger', messageGoal: 'None' },
  EMERGING_TRIGGER: { stance: 'NURTURE', move: 'Don\'t sell yet — share something useful and keep watching', messageGoal: 'Be remembered when the need firms up' },
  PROBLEM_LIKELY: { stance: 'QUALIFY', move: 'Ask a qualifying question about the likely problem', messageGoal: 'Confirm the problem exists and who owns it' },
  ACTIVE_REQUIREMENT: { stance: 'ENGAGE', move: 'Start outreach now, tied to the triggering event', messageGoal: 'Get a conversation about the requirement' },
  EVALUATING_SOLUTIONS: { stance: 'PROVE', move: 'Send proof — a relevant case study or comparison', messageGoal: 'Get shortlisted against alternatives' },
  BUYING_DECISION: { stance: 'CLOSE', move: 'Push toward a quote or a decision meeting', messageGoal: 'Remove the last objections and agree terms' },
  CUSTOMER: { stance: 'EXPAND', move: 'Deliver, then look for repeat and expansion work', messageGoal: 'Retain and grow the account' },
}

const ORDER: Record<BuyingStageV2, number> = Object.fromEntries(BUYING_STAGES.map((s, i) => [s, i])) as Record<BuyingStageV2, number>

/** The furthest stage each event kind can indicate on evidence alone. */
const KIND_STAGE: Record<CommercialEventKind, BuyingStageV2> = {
  TENDER_OPPORTUNITY: 'EVALUATING_SOLUTIONS',
  CONTRACT_OPPORTUNITY: 'EVALUATING_SOLUTIONS',
  PROCUREMENT_CHANGE: 'EVALUATING_SOLUTIONS',
  CAPACITY_SHORTAGE: 'ACTIVE_REQUIREMENT',
  NEW_PROJECT: 'ACTIVE_REQUIREMENT',
  CAPACITY_EXPANSION: 'ACTIVE_REQUIREMENT',
  HIRING_SURGE: 'ACTIVE_REQUIREMENT',
  OPERATIONAL_DISRUPTION: 'ACTIVE_REQUIREMENT',
  GEOGRAPHIC_EXPANSION: 'PROBLEM_LIKELY',
  FUNDING_DEPLOYMENT: 'PROBLEM_LIKELY',
  TECHNOLOGY_REPLACEMENT: 'PROBLEM_LIKELY',
  REGULATORY_CHANGE: 'PROBLEM_LIKELY',
  LEADERSHIP_RESET: 'PROBLEM_LIKELY',
  EARLY_TRIGGER: 'EMERGING_TRIGGER',
}

/** Below this confidence an event only counts as an emerging trigger. */
const MIN_EVENT_CONFIDENCE = 55

function stageFromEvent(e: CommercialEventHypothesis): { stage: BuyingStageV2; capped: boolean } {
  if (e.confidence < MIN_EVENT_CONFIDENCE) return { stage: 'EMERGING_TRIGGER', capped: KIND_STAGE[e.kind] !== 'EMERGING_TRIGGER' }
  const stage = KIND_STAGE[e.kind]
  // Gate 1: one uncorroborated source can suggest a problem, not prove a requirement.
  if (!e.corroborated && ORDER[stage] > ORDER.PROBLEM_LIKELY) return { stage: 'PROBLEM_LIKELY', capped: true }
  return { stage, capped: false }
}

export function inferBuyingStage(input: {
  events: CommercialEventHypothesis[]
  engagement?: EngagementStage | null
}): BuyingStageAssessment {
  const reasons: string[] = []
  const engagement = input.engagement ?? null

  if (engagement === 'WON') return done('CUSTOMER', 95, ['Recorded as won'])

  // Strongest stage any event supports; ties go to the more confident event.
  let best: { stage: BuyingStageV2; event: CommercialEventHypothesis | null; capped: boolean } = { stage: 'NO_DETECTABLE_NEED', event: null, capped: false }
  for (const e of input.events) {
    const s = stageFromEvent(e)
    if (ORDER[s.stage] > ORDER[best.stage] || (s.stage === best.stage && best.event && e.confidence > best.event.confidence)) {
      best = { stage: s.stage, event: e, capped: s.capped }
    }
  }
  let stage = best.stage
  let confidence = best.event ? best.event.confidence : 70
  if (best.event) {
    reasons.push(`${best.event.title} (${best.event.confidence}%) indicates ${label(stage)}`)
    if (best.capped) reasons.push(best.event.corroborated ? 'Event confidence too low to place the company further' : 'Uncorroborated — held at "problem likely" until confirmed')
  } else {
    reasons.push('No commercial event in the recent evidence')
  }

  // Recorded engagement moves the stage forward; evidence alone never reaches a decision.
  if (engagement === 'PROPOSAL' || engagement === 'MEETING') {
    stage = 'BUYING_DECISION'
    confidence = engagement === 'PROPOSAL' ? 90 : 80
    reasons.push(engagement === 'PROPOSAL' ? 'A proposal is with the buyer' : 'A meeting has taken place')
  } else if (engagement === 'LOST') {
    reasons.push('A previous opportunity was lost — re-engage only on a new trigger')
  }

  return done(stage, confidence, reasons)
}

function done(stage: BuyingStageV2, confidence: number, reasons: string[]): BuyingStageAssessment {
  return {
    stage, confidence: Math.max(0, Math.min(100, Math.round(confidence))), reasons,
    play: STAGE_PLAYBOOK[stage],
    outreachAppropriate: ORDER[stage] >= ORDER.ACTIVE_REQUIREMENT && stage !== 'CUSTOMER',
  }
}

function label(stage: BuyingStageV2): string {
  return stage.toLowerCase().replace(/_/g, ' ')
}
