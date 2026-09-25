// Shared shapes for work discovery ("Find work"). A source connector normalizes
// whatever its upstream returns into an OpportunityCandidate; the matcher decides
// whether it is relevant to a workspace and why; the sweep persists it as an
// Opportunity. Kept dependency-free so sources, matcher and tests share it.

export type OpportunityKind = 'CONTRACT_AWARD' | 'DEVELOPMENT_APPLICATION'

export const OPPORTUNITY_STATUSES = ['NEW', 'PURSUING', 'WON', 'LOST', 'DISMISSED'] as const
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number]

export type OpportunityClassification = { scheme: string; id: string; description?: string }

export type OpportunityParty = {
  name: string
  abn?: string
  email?: string
  phone?: string
}

export type OpportunityCandidate = {
  externalId: string
  kind: OpportunityKind
  title: string
  description?: string
  address?: string
  locality?: string
  /** Australian state/territory code (QLD, NSW, ...). */
  region?: string
  postcode?: string
  lat?: number
  lng?: number
  valueAmount?: number
  currency?: string
  publishedAt?: Date
  sourceUrl?: string
  classifications?: OpportunityClassification[]
  /** Who to approach — e.g. the head contractor that won the contract. */
  counterparty?: OpportunityParty
  /** Who the work is for — e.g. the procuring agency. */
  buyer?: OpportunityParty
  /** The body the application was lodged with — e.g. a council. */
  authority?: string
  /** Trimmed upstream payload kept for provenance. */
  raw?: unknown
}

/** The subset of DiscoveryProfile the matcher and sources read. */
export type DiscoveryProfileInput = {
  trades: string[]
  keywords: string[]
  baseLat: number | null
  baseLng: number | null
  radiusKm: number
  regions: string[]
  minValue: number | null
}

export const AU_REGIONS = ['ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA'] as const

/** Pull a state code (and postcode) out of a free-text Australian address. */
export function parseAuRegion(text: string | null | undefined): { region?: string; postcode?: string } {
  if (!text) return {}
  const m = text.toUpperCase().match(/\b(ACT|NSW|NT|QLD|SA|TAS|VIC|WA)\b(?:\s*,?\s*(\d{4}))?/)
  if (m) return { region: m[1], ...(m[2] ? { postcode: m[2] } : {}) }
  const pc = text.match(/\b(\d{4})\b\s*$/)
  return pc ? { postcode: pc[1] } : {}
}

/** Normalize state names/codes ("Queensland", "qld") to a code, or undefined. */
export function normalizeAuRegion(value: string | null | undefined): string | undefined {
  if (!value) return undefined
  const v = value.trim().toUpperCase()
  if ((AU_REGIONS as readonly string[]).includes(v)) return v
  const names: Record<string, string> = {
    'AUSTRALIAN CAPITAL TERRITORY': 'ACT', 'NEW SOUTH WALES': 'NSW', 'NORTHERN TERRITORY': 'NT',
    QUEENSLAND: 'QLD', 'SOUTH AUSTRALIA': 'SA', TASMANIA: 'TAS', VICTORIA: 'VIC', 'WESTERN AUSTRALIA': 'WA',
  }
  return names[v] ?? parseAuRegion(v).region
}
