// Shared buying-signal vocabulary, so message relevance ("does the message
// reference a known trigger?") and timing fit ("how fresh and how strong is
// the trigger?") classify evidence identically.
export type BuyingSignal = 'tender' | 'expansion' | 'funding' | 'hiring' | 'launch' | 'leadership'

export const BUYING_SIGNAL_PATTERNS: ReadonlyArray<[BuyingSignal, RegExp]> = [
  ['hiring', /\b(hiring|recruit\w*|job openings?|open (roles|positions))\b/],
  ['expansion', /\b(expand\w*|expansion|new (site|location|office|branch|depot)|opened|opening)\b/],
  ['funding', /\b(funding|raised|investment|series [a-d])\b/],
  ['tender', /\b(tenders?|contract (win|awarded)|won (a|the) contract|awarded|procurement)\b/],
  ['launch', /\b(launch\w*|new (product|service|website))\b/],
  ['leadership', /\b(new (ceo|director|manager|owner)|appointed)\b/],
]

export function classifySignals(text: string): BuyingSignal[] {
  const t = text.toLowerCase()
  return BUYING_SIGNAL_PATTERNS.filter(([, re]) => re.test(t)).map(([s]) => s)
}
