// Labelled-case shapes for the relationship-graph evaluation (design:
// docs/design/RELATIONSHIP_GRAPH.md §11). All data here is SYNTHETIC: invented
// organisations, invented 11-digit ABNs (not checksum-valid, not real entities)
// and invented councils/agencies. No tenant data, no real notices.
import type { TradeId } from '../../../../packages/backend-core/src/lib/opportunityTaxonomy.ts'

export type Party = { name: string; abn?: string }

/** One source record about a project, shaped like the fields an Opportunity keeps. */
export type SourceRecord = {
  recordId: string
  /** Registry key (lib/sourceRegistry.ts) or an invented feed that has no registry entry. */
  source: string
  externalId: string
  kind: 'CONTRACT_AWARD' | 'DEVELOPMENT_APPLICATION'
  title: string
  description?: string
  /** YYYY-MM-DD. */
  publishedAt: string
  counterparty?: Party
  buyer?: { name: string }
  authority?: string
  classifications?: Array<{ scheme: string; id: string; description?: string }>
  valueAmount?: number
  region?: string
  locality?: string
}

/**
 * builder = the contractor appointed to deliver the project/scope as principal.
 * A design, project-management, QS or supply-only supplier is NOT a builder, and a standing
 * panel arrangement appoints no builder to any project. A specialist contractor appointed
 * directly for a narrowly named scope (e.g. a switchboard upgrade) IS the principal contractor
 * for that scope; whether such scopes should count as "builder" is a policy call for the labelling
 * owner (design D5) and is flagged in docs/design/RELATIONSHIP_GRAPH.md §11.6.
 * CONFLICT = the records name different builders and nothing in them resolves it.
 */
export type BuilderTruth =
  | { status: 'KNOWN'; name: string; abn?: string }
  | { status: 'UNKNOWN' }
  | { status: 'CONFLICT'; candidates: Party[] }

/**
 * STATED  = the record's own text names the trade, or names work that is by definition that
 *           trade's licensed scope (switchboard, sprinkler, solar PV, hydraulic services).
 * IMPLIED = nothing states it, but this kind of project will normally need it.
 * ABSENT  = the record affirms it is out of scope, or the scope is a single narrowly named
 *           work type that excludes it. Anything merely unmentioned is NOT labelled ABSENT.
 * Trades not listed are not evaluated for that case.
 */
export type TradeLabel = 'STATED' | 'IMPLIED' | 'ABSENT'

export type GraphCase = {
  id: string
  stratum: string
  note: string
  records: SourceRecord[]
  truth: {
    builder: BuilderTruth
    /** Client / developer / procuring party, or null when the records do not say. */
    developer: string | null
    trades: Partial<Record<TradeId, TradeLabel>>
  }
}

export type EntityPairKind =
  | 'name_variant' | 'bracket_variant' | 'abbreviation' | 'abn_trading_name'
  | 'distinct_similar' | 'same_name_different_abn'

export type EntityPair = {
  id: string
  kind: EntityPairKind
  a: Party
  b: Party
  /** Truth: are these the same legal entity? */
  same: boolean
  /** Why the truth is what it is (e.g. the synthetic ABR registration), so a reviewer can check it. */
  labelBasis: string
}

export type UnsupportedKind =
  | 'none' | 'number' | 'recency' | 'qualitative' | 'misattributed_party' | 'unstated_requirement'

export type GroundingDraft = {
  id: string
  /** What the draft is supposed to be written from. */
  facts: Array<{ claim: string; source: string; sourceUrl: string | null; ageDays: number; quality: number }>
  subject: string
  body: string
  /** Truth: does the draft state something its facts do not support? */
  unsupported: UnsupportedKind
}
