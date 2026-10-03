// Money in the delivery screens is integer cents on the wire (phase 15A); these
// convert at the edge. Blank input is "unknown" (null), never zero.

export function formatCents(cents: number | null | undefined): string {
  if (cents == null) return '—'
  const sign = cents < 0 ? '-' : ''
  return `${sign}$${Math.round(Math.abs(cents) / 100).toLocaleString('en-AU')}`
}

/** "$60,000" / "60000.50" → cents; blank → null; anything else → NaN. */
export function parseDollars(input: string): number | null {
  const t = input.replace(/[$,\s]/g, '')
  if (t === '') return null
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return NaN
  return Math.round(Number(t) * 100)
}

export function formatPct(p: number | null | undefined): string {
  return p == null ? '—' : `${p > 0 ? '+' : ''}${p}%`
}
