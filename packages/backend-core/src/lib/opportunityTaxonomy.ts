// Trade taxonomy for work discovery. Deterministic on purpose: every match must
// be explainable ("the contract is classified as electrical services"), and a
// keyword list is easy for a tradesperson to read and correct. Keywords are
// matched case-insensitively on word boundaries; a trailing '*' matches any
// suffix ("rewir*" → rewire, rewiring).

export type TradeId =
  | 'electrical' | 'plumbing' | 'hvac' | 'fire_protection' | 'carpentry' | 'painting'
  | 'roofing' | 'concreting' | 'landscaping' | 'building' | 'demolition' | 'flooring'
  | 'glazing' | 'security' | 'cleaning'

export type Trade = { id: TradeId; label: string; keywords: string[] }

export const TRADES: readonly Trade[] = [
  { id: 'electrical', label: 'Electrical', keywords: ['electrical', 'electrician*', 'switchboard*', 'lighting', 'rewir*', 'cabling', 'data cabling', 'solar', 'photovoltaic', 'substation*', 'ev charg*', 'power upgrade*'] },
  { id: 'plumbing', label: 'Plumbing', keywords: ['plumbing', 'plumber*', 'drainage', 'sewer*', 'hydraulic*', 'stormwater', 'water main*', 'backflow', 'hot water', 'gas fitting', 'gasfitting'] },
  { id: 'hvac', label: 'Air conditioning & HVAC', keywords: ['hvac', 'air conditioning', 'air-conditioning', 'airconditioning', 'mechanical services', 'ventilation', 'chiller*', 'refrigeration', 'heating'] },
  { id: 'fire_protection', label: 'Fire protection', keywords: ['fire protection', 'fire services', 'sprinkler*', 'fire alarm*', 'fire detection', 'hydrant*', 'fire safety'] },
  { id: 'carpentry', label: 'Carpentry & joinery', keywords: ['carpentry', 'carpenter*', 'joinery', 'framing', 'cabinetry', 'timber work*'] },
  { id: 'painting', label: 'Painting', keywords: ['painting', 'painter*', 'repaint*', 'protective coating*'] },
  { id: 'roofing', label: 'Roofing', keywords: ['roofing', 'roofer*', 're-roof*', 'reroof*', 'roof replacement', 'roof repair*', 'guttering'] },
  { id: 'concreting', label: 'Concreting', keywords: ['concret*', 'slab*', 'footpath*', 'kerb*'] },
  { id: 'landscaping', label: 'Landscaping', keywords: ['landscap*', 'grounds maintenance', 'turf', 'irrigation', 'garden maintenance'] },
  { id: 'building', label: 'Building & fit-out', keywords: ['construction', 'construct', 'refurbish*', 'fit-out', 'fitout', 'fit out', 'renovat*', 'extension', 'alterations', 'building works', 'new building', 'warehouse', 'multiple dwelling', 'dual occupancy', 'townhouse*', 'apartment*'] },
  { id: 'demolition', label: 'Demolition & asbestos', keywords: ['demoli*', 'asbestos'] },
  { id: 'flooring', label: 'Flooring & tiling', keywords: ['flooring', 'floor covering*', 'carpet*', 'tiling', 'vinyl'] },
  { id: 'glazing', label: 'Glazing & windows', keywords: ['glazing', 'glazier*', 'shopfront*', 'curtain wall', 'window replacement'] },
  { id: 'security', label: 'Security systems', keywords: ['security system*', 'cctv', 'access control', 'intruder alarm*'] },
  { id: 'cleaning', label: 'Commercial cleaning', keywords: ['cleaning', 'cleaner*', 'janitorial'] },
]

export const TRADE_IDS: readonly TradeId[] = TRADES.map(t => t.id)

export function tradeById(id: string): Trade | undefined {
  return TRADES.find(t => t.id === id)
}

// Trades a head contractor usually subcontracts on a general building job, and
// that a new commercial / multi-unit development will need. Used for "implied"
// matches: "construct a warehouse" never says "electrical", but needs it.
export const IMPLIED_BY_BUILD: ReadonlySet<TradeId> = new Set<TradeId>([
  'electrical', 'plumbing', 'hvac', 'fire_protection', 'carpentry', 'painting', 'roofing',
  'concreting', 'landscaping', 'flooring', 'glazing', 'security',
])

// Scale words on a development application. Big → a real subcontracting
// opportunity; minor → a homeowner job unlikely to need a commercial trade.
export const LARGE_SCALE_KEYWORDS = ['commercial', 'industrial', 'warehouse', 'multiple dwelling', 'multi-unit', 'apartment*', 'units', 'storey', 'shopping', 'retail', 'office', 'childcare', 'child care', 'hospital', 'school', 'aged care', 'hotel', 'mixed use', 'fitout', 'fit-out', 'townhouse*']
export const MINOR_SCALE_KEYWORDS = ['swimming pool', 'pool', 'carport', 'shed', 'fence', 'tree', 'signage', 'sign', 'patio', 'deck', 'retaining wall', 'home business']

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const regexCache = new Map<string, RegExp>()

/** One case-insensitive, word-bounded regex for a keyword list. */
export function keywordRegex(keywords: readonly string[]): RegExp | null {
  const cleaned = keywords.map(k => k.trim()).filter(Boolean)
  if (cleaned.length === 0) return null
  const key = cleaned.join('\u0000')
  let re = regexCache.get(key)
  if (!re) {
    const parts = cleaned.map(k => {
      const wildcard = k.endsWith('*')
      const body = escapeRegex(wildcard ? k.slice(0, -1) : k).replace(/\s+/g, '[\\s-]+')
      return wildcard ? `${body}\\w*` : `${body}\\b`
    })
    re = new RegExp(`\\b(?:${parts.join('|')})`, 'i')
    if (regexCache.size > 500) regexCache.clear()
    regexCache.set(key, re)
  }
  return re
}

/** The first keyword-list hit in `text`, or null. */
export function findKeyword(text: string | null | undefined, keywords: readonly string[]): string | null {
  if (!text) return null
  const re = keywordRegex(keywords)
  const m = re ? text.match(re) : null
  return m ? m[0] : null
}
