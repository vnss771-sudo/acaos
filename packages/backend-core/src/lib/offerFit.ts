export type OfferFit = {
  score: number
  matchedTerms: string[]
  reason: string
}

function terms(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? []
}

/** Conservative lexical fit. It is a floor for later learned models, not an AI claim. */
export function scoreOfferFit(offer: string | null | undefined, evidenceText: string): OfferFit {
  if (!offer?.trim() || !evidenceText.trim()) return { score: 50, matchedTerms: [], reason: 'Offer or evidence is not specific enough to determine fit.' }
  const offerTerms = [...new Set(terms(offer).filter(t => t.length >= 4))]
  const evidence = new Set(terms(evidenceText))
  const matchedTerms = offerTerms.filter(t => evidence.has(t)).slice(0, 8)
  if (offerTerms.length === 0) return { score: 50, matchedTerms: [], reason: 'Offer contains no useful matching terms.' }
  const ratio = matchedTerms.length / Math.min(offerTerms.length, 6)
  const score = Math.max(0, Math.min(100, Math.round(25 + ratio * 75)))
  return {
    score,
    matchedTerms,
    reason: matchedTerms.length > 0
      ? `Evidence matches ${matchedTerms.length} offer term${matchedTerms.length === 1 ? '' : 's'}: ${matchedTerms.join(', ')}`
      : 'No direct offer terms were found in the evidence.',
  }
}
