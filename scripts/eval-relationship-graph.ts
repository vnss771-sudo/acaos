// Offline baseline for the construction relationship graph (docs/design/RELATIONSHIP_GRAPH.md §11).
//
// Measures what ACAOS can do TODAY, with no graph, against a labelled gold set, so any
// later graph work has a number to beat before thresholds are fixed. Pure and
// deterministic: no network, no database, no model call, no clock (EVAL_NOW is fixed).
//
//   npx tsx scripts/eval-relationship-graph.ts           print metrics
//   npx tsx scripts/eval-relationship-graph.ts --write   regenerate baseline.json
//
// "Baseline" modelling choices (explicit, because today's product has no project concept):
//   builder   = counterparty of the LATEST CONTRACT_AWARD record for the project; none → UNKNOWN.
//               (The sweep stores each notice as its own Opportunity; the case grouping is given to
//               the baseline for free, which flatters it.)
//   developer = buyer of that same award, else none.
//   trade     = matchOpportunity() against a profile that selects only that trade, per record.
//   same org  = normalizeCompanyNameKey equality, or equal ABN (today's Prospect dedupe keys).
//   grounding = checkDraftGrounding() as shipped.
import { readFileSync, writeFileSync } from 'node:fs'
import { matchOpportunity, isRejection } from '../packages/backend-core/src/lib/opportunityMatch.ts'
import { normalizeCompanyNameKey } from '../packages/backend-core/src/lib/normalize.ts'
import { checkDraftGrounding, factsFromCitations, initialGrounding } from '../packages/backend-core/src/lib/draftGrounding.ts'
import { getSourceLicence } from '../packages/backend-core/src/lib/sourceRegistry.ts'
import type { OpportunityCandidate, DiscoveryProfileInput } from '../packages/backend-core/src/lib/opportunityTypes.ts'
import type { TradeId } from '../packages/backend-core/src/lib/opportunityTaxonomy.ts'
import { CASES } from '../eval/datasets/v2/relationship-graph/cases.ts'
import { PAIRS } from '../eval/datasets/v2/relationship-graph/pairs.ts'
import { DRAFTS } from '../eval/datasets/v2/relationship-graph/drafts.ts'
import type {
  EntityPair, EntityPairKind, GraphCase, GroundingDraft, Party, SourceRecord, UnsupportedKind,
} from '../eval/datasets/v2/relationship-graph/types.ts'

export const EVAL_NOW = new Date('2026-10-01T00:00:00Z')
export const BASELINE_PATH = 'eval/datasets/v2/relationship-graph/baseline.json'

const r3 = (n: number): number => Math.round(n * 1000) / 1000
const rate = (num: number, den: number): number | null => (den === 0 ? null : r3(num / den))

// ── Baseline predictors ──────────────────────────────────────────────────────

export function toCandidate(r: SourceRecord): OpportunityCandidate {
  return {
    externalId: r.externalId, kind: r.kind, title: r.title,
    ...(r.description ? { description: r.description } : {}),
    ...(r.locality ? { locality: r.locality } : {}),
    ...(r.region ? { region: r.region } : {}),
    ...(r.valueAmount != null ? { valueAmount: r.valueAmount } : {}),
    publishedAt: new Date(`${r.publishedAt}T00:00:00Z`),
    ...(r.classifications ? { classifications: r.classifications } : {}),
    ...(r.counterparty ? { counterparty: r.counterparty } : {}),
    ...(r.buyer ? { buyer: r.buyer } : {}),
    ...(r.authority ? { authority: r.authority } : {}),
  }
}

function latestAward(records: readonly SourceRecord[]): SourceRecord | null {
  const awards = records.filter(r => r.kind === 'CONTRACT_AWARD' && r.counterparty)
  if (awards.length === 0) return null
  return awards.reduce((best, r) => (r.publishedAt >= best.publishedAt ? r : best))
}

export type BuilderPrediction = { status: 'KNOWN'; party: Party; recordId: string; source: string } | { status: 'UNKNOWN' }

export function predictBuilder(records: readonly SourceRecord[]): BuilderPrediction {
  const a = latestAward(records)
  return a ? { status: 'KNOWN', party: a.counterparty!, recordId: a.recordId, source: a.source } : { status: 'UNKNOWN' }
}

export function predictDeveloper(records: readonly SourceRecord[]): string | null {
  return latestAward(records)?.buyer?.name ?? null
}

export function sameParty(a: Party, b: Party): boolean {
  if (a.abn && b.abn) return a.abn === b.abn
  const ka = normalizeCompanyNameKey(a.name)
  return ka !== null && ka === normalizeCompanyNameKey(b.name)
}

/** Today's "same organisation" rule: equal normalised name key, or equal ABN. */
export function baselineSameEntity(a: Party, b: Party): boolean {
  if (a.abn && a.abn === b.abn) return true
  const ka = normalizeCompanyNameKey(a.name)
  return ka !== null && ka === normalizeCompanyNameKey(b.name)
}

const profileFor = (trade: TradeId): DiscoveryProfileInput =>
  ({ trades: [trade], keywords: [], baseLat: null, baseLng: null, radiusKm: 50, regions: [], minValue: null })

export function predictTradeRequired(records: readonly SourceRecord[], trade: TradeId): boolean {
  return records.some(r => {
    const m = matchOpportunity(toCandidate(r), profileFor(trade), EVAL_NOW)
    return !isRejection(m) && m.matchedTrades.includes(trade)
  })
}

export function baselineGrounded(d: GroundingDraft): boolean {
  const facts = factsFromCitations(d.facts.map(f => ({
    signalId: null, claim: f.claim, source: f.source, sourceUrl: f.sourceUrl,
    eventDate: new Date(EVAL_NOW.getTime() - f.ageDays * 86_400_000).toISOString(), ageDays: f.ageDays, quality: f.quality,
  })))
  const out = checkDraftGrounding({ subject: d.subject, body: d.body }, initialGrounding(facts, []), { now: EVAL_NOW.getTime() })
  return out.grounded === true
}

const sourceIsConfirmed = (source: string): boolean => getSourceLicence(source)?.commercialUse === 'confirmed'

// ── Metrics ──────────────────────────────────────────────────────────────────

export function computeBaseline(
  cases: readonly GraphCase[] = CASES,
  pairs: readonly EntityPair[] = PAIRS,
  drafts: readonly GroundingDraft[] = DRAFTS,
) {
  // Builder identity, unknown states, conflicts, supersession.
  let assertions = 0, correct = 0, wrong = 0, knownCases = 0, missed = 0, nameOnly = 0, solelyNonConfirmed = 0
  let unknownCases = 0, unknownCorrect = 0, fabricated = 0
  let conflictCases = 0, conflictPicked = 0
  const conflictDetected = 0 // the baseline has no way to detect one
  let supersessionCases = 0, supersessionCorrect = 0
  const wrongBuilderIds: string[] = [], fabricatedIds: string[] = [], missedIds: string[] = [], conflictIds: string[] = []
  let developerCorrect = 0, roleSwaps = 0
  const roleSwapIds: string[] = [], developerWrongIds: string[] = []

  for (const c of cases) {
    const pred = predictBuilder(c.records)
    const t = c.truth.builder
    if (pred.status === 'KNOWN') {
      assertions++
      if (!pred.party.abn) nameOnly++
      if (!sourceIsConfirmed(pred.source)) solelyNonConfirmed++
    }
    if (t.status === 'KNOWN') {
      knownCases++
      const ok = pred.status === 'KNOWN' && sameParty(pred.party, { name: t.name, ...(t.abn ? { abn: t.abn } : {}) })
      if (ok) correct++
      else if (pred.status === 'KNOWN') { wrong++; wrongBuilderIds.push(c.id) } else { missed++; missedIds.push(c.id) }
      if (c.stratum === 'supersession') { supersessionCases++; if (ok) supersessionCorrect++ }
    } else if (t.status === 'UNKNOWN') {
      unknownCases++
      if (pred.status === 'UNKNOWN') unknownCorrect++
      else { fabricated++; fabricatedIds.push(c.id) }
    } else {
      conflictCases++
      conflictIds.push(c.id)
      // Baseline has no concept of conflicting evidence, so nothing is ever flagged.
      if (pred.status === 'KNOWN') conflictPicked++
    }

    // Project-specific roles.
    const dev = predictDeveloper(c.records)
    const devOk = (dev === null && c.truth.developer === null) ||
      (dev !== null && c.truth.developer !== null && normalizeCompanyNameKey(dev) === normalizeCompanyNameKey(c.truth.developer))
    if (devOk) developerCorrect++; else developerWrongIds.push(c.id)
    if (pred.status === 'KNOWN' && c.truth.developer !== null &&
        normalizeCompanyNameKey(pred.party.name) === normalizeCompanyNameKey(c.truth.developer) &&
        !(t.status === 'KNOWN' && sameParty(pred.party, { name: t.name }))) {
      roleSwaps++; roleSwapIds.push(c.id)
    }
  }

  // Trade requirements.
  const tr = { STATED: { n: 0, req: 0 }, IMPLIED: { n: 0, req: 0 }, ABSENT: { n: 0, req: 0 } }
  const trMissed: string[] = [], trFalsePos: string[] = []
  for (const c of cases) {
    for (const [trade, label] of Object.entries(c.truth.trades) as Array<[TradeId, 'STATED' | 'IMPLIED' | 'ABSENT']>) {
      const predicted = predictTradeRequired(c.records, trade)
      tr[label].n++
      if (predicted) tr[label].req++
      if (label === 'STATED' && !predicted) trMissed.push(`${c.id}:${trade}`)
      if (label === 'ABSENT' && predicted) trFalsePos.push(`${c.id}:${trade}`)
    }
  }

  // Entity resolution.
  const byKind: Partial<Record<EntityPairKind, { n: number; correct: number }>> = {}
  let falseMerges = 0, falseSplits = 0, pairCorrect = 0
  const pairWrong: string[] = []
  for (const p of pairs) {
    const predicted = baselineSameEntity(p.a, p.b)
    const slot = (byKind[p.kind] ??= { n: 0, correct: 0 })
    slot.n++
    if (predicted === p.same) { slot.correct++; pairCorrect++ } else {
      pairWrong.push(p.id)
      if (predicted && !p.same) falseMerges++
      if (!predicted && p.same) falseSplits++
    }
  }

  // Grounding.
  const kinds: Partial<Record<UnsupportedKind, { n: number; flagged: number }>> = {}
  let unsupported = 0, flagged = 0, supported = 0, wronglyBlocked = 0
  const groundMissed: string[] = [], groundWrongBlock: string[] = []
  for (const d of drafts) {
    const grounded = baselineGrounded(d)
    if (d.unsupported === 'none') {
      supported++
      if (!grounded) { wronglyBlocked++; groundWrongBlock.push(d.id) }
    } else {
      unsupported++
      const slot = (kinds[d.unsupported] ??= { n: 0, flagged: 0 })
      slot.n++
      if (!grounded) { flagged++; slot.flagged++ } else groundMissed.push(d.id)
    }
  }

  const allRecords = cases.flatMap(c => c.records)
  const sortKeys = <T,>(o: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)))

  return {
    datasetVersion: 'v2',
    labelled: { projects: cases.length, entityPairs: pairs.length, groundingDrafts: drafts.length, sourceRecords: allRecords.length },
    builderIdentity: {
      knownCases, assertions, correct, wrong, missed,
      precision: rate(correct, assertions), recall: rate(correct, knownCases),
      // The baseline has no verification state: every assertion is implicitly "confirmed".
      falseConfirmationRate: rate(assertions - correct, assertions),
      nameOnlyAssertionRate: rate(nameOnly, assertions),
      wrongBuilderCases: wrongBuilderIds, missedCases: missedIds,
    },
    unknownStates: {
      unknownCases, correctlyUnknown: unknownCorrect, fabricatedBuilder: fabricated,
      unknownCorrectness: rate(unknownCorrect, unknownCases), fabricatedCases: fabricatedIds,
    },
    conflicts: {
      conflictCases, detected: conflictDetected, silentlyResolvedToOneBuilder: conflictPicked,
      detectionRate: rate(conflictDetected, conflictCases), cases: conflictIds,
    },
    supersession: { cases: supersessionCases, correct: supersessionCorrect },
    projectRoles: {
      cases: cases.length, developerCorrect, developerAccuracy: rate(developerCorrect, cases.length),
      builderDeveloperSwaps: roleSwaps, swapCases: roleSwapIds, developerWrongCases: developerWrongIds,
    },
    tradeRequirements: {
      stated: { pairs: tr.STATED.n, predictedRequired: tr.STATED.req, recall: rate(tr.STATED.req, tr.STATED.n), missed: trMissed },
      absent: { pairs: tr.ABSENT.n, predictedRequired: tr.ABSENT.req, falsePositiveRate: rate(tr.ABSENT.req, tr.ABSENT.n), falsePositives: trFalsePos },
      // Baseline cannot tell "stated" from "implied": any implied trade it surfaces looks identical to a stated one.
      implied: { pairs: tr.IMPLIED.n, surfacedAsRequired: tr.IMPLIED.req, conflationRate: rate(tr.IMPLIED.req, tr.IMPLIED.n) },
    },
    entityResolution: {
      pairs: pairs.length, accuracy: rate(pairCorrect, pairs.length), falseMerges, falseSplits,
      byKind: sortKeys(Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, { ...v!, accuracy: rate(v!.correct, v!.n) }]))),
      wrongPairs: pairWrong,
    },
    grounding: {
      unsupportedDrafts: unsupported, flagged, detectionRate: rate(flagged, unsupported),
      byKind: sortKeys(Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, { ...v!, detectionRate: rate(v!.flagged, v!.n) }]))),
      supportedDrafts: supported, wronglyBlocked, falseBlockRate: rate(wronglyBlocked, supported),
      missedDrafts: groundMissed, wronglyBlockedDrafts: groundWrongBlock,
    },
    licence: {
      recordsFromNonConfirmedOrUnregistered: allRecords.filter(r => !sourceIsConfirmed(r.source)).length,
      recordShare: rate(allRecords.filter(r => !sourceIsConfirmed(r.source)).length, allRecords.length),
      builderAssertionsSolelyOnNonConfirmed: solelyNonConfirmed,
      assertionShare: rate(solelyNonConfirmed, assertions),
    },
    notMeasurableAtBaseline: [
      'confidence calibration (no confidence on builder claims)',
      'tenant leakage (no graph tables)',
      'review/audit completeness (no review workflow)',
      'multi-evidence corroboration (one record per claim)',
    ],
  }
}

export type BaselineMetrics = ReturnType<typeof computeBaseline>

export function readStoredBaseline(path: string = BASELINE_PATH): BaselineMetrics {
  return JSON.parse(readFileSync(path, 'utf8')) as BaselineMetrics
}

function main(): void {
  const metrics = computeBaseline()
  const json = `${JSON.stringify(metrics, null, 2)}\n`
  if (process.argv.includes('--write')) {
    writeFileSync(BASELINE_PATH, json)
    console.log(`[eval:graph-baseline] wrote ${BASELINE_PATH}`)
  }
  process.stdout.write(json)
}

if (process.argv[1] && process.argv[1].endsWith('eval-relationship-graph.ts')) main()
