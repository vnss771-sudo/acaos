// Canonical normalization helpers for dedupe keys. Pure and dependency-free so
// they can be unit-tested in isolation and shared by the API (import/discovery)
// and worker. The keys are intentionally lossy: they collapse the surface
// variations (case, whitespace, www., punctuation, plus-addressing) that
// otherwise produce duplicate prospects/leads for the same real-world entity.

/**
 * Normalize a domain for dedupe: lowercase, strip a leading `www.`, drop any
 * scheme/path/port if a full URL slipped in. Returns null for empty input.
 */
export function normalizeDomain(domain: string | null | undefined): string | null {
  if (!domain) return null
  let d = domain.trim().toLowerCase()
  if (!d) return null
  // Strip scheme + path if a URL was passed instead of a bare host.
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, '') // scheme://
  d = d.replace(/[/?#].*$/, '')                 // path/query/fragment
  d = d.replace(/:\d+$/, '')                     // :port
  d = d.replace(/^www\./, '')
  return d || null
}

/**
 * Normalize a company name for dedupe: lowercase, collapse internal whitespace,
 * strip punctuation, and drop trailing legal-entity suffixes (inc, llc, ltd,
 * corp, co, gmbh, pty, plc). "Acme, Inc." and "ACME LLC" both key to "acme".
 * Returns null when nothing meaningful remains.
 */
export function normalizeCompanyNameKey(name: string | null | undefined): string | null {
  if (!name) return null
  let n = name.trim().toLowerCase()
  if (!n) return null
  // Replace punctuation with spaces, then collapse whitespace.
  n = n.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!n) return null
  // Drop one trailing legal-entity suffix token (e.g. "acme inc" -> "acme").
  const suffixes = new Set(['inc', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company', 'gmbh', 'pty', 'plc', 'lp', 'llp'])
  const tokens = n.split(' ')
  while (tokens.length > 1 && suffixes.has(tokens[tokens.length - 1])) {
    tokens.pop()
  }
  const key = tokens.join(' ').trim()
  return key || null
}

/**
 * Deterministic, dependency-free deliverability check: is this address shaped
 * like something we can actually send to? Rejects control chars, whitespace, a
 * missing/duplicate `@`, and domains without a dotted TLD. Mirrors the API's
 * isValidEmail so the worker can reject obviously-invalid addresses before
 * claiming/generating (skip reason INVALID_EMAIL) instead of burning an SMTP
 * attempt and hurting sender reputation. NOT a guarantee of deliverability — just
 * a cheap structural gate.
 */
export function isDeliverableEmail(email: string | null | undefined): boolean {
  if (!email) return false
  const e = email.trim()
  if (!e) return false
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(e)) return false
  // ReDoS-safe: dot-separated labels that exclude '.', so adjacent '+' groups
  // can't both match the same dot. Mirrors apps/api isValidEmail.
  return /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(e.toLowerCase())
}

/**
 * Suppression/contact-key normalization: trim + lowercase ONLY. Deliberately does
 * NOT fold plus-addressing — for suppression and contact-frequency we treat
 * `john+test@x.com` and `john@x.com` as DISTINCT recipients (provider-specific
 * plus-equivalence can be layered on later if the product wants it). This is the
 * single normalizer behind Suppression.emailKey and all suppression lookups, so
 * both sides of every comparison are normalized the same way.
 *
 * Distinct from normalizeEmailKey (below), which DOES fold plus-tags and is used
 * for prospect/lead identity dedupe.
 */
export function normalizeEmail(email: string | null | undefined): string {
  return (email ?? '').trim().toLowerCase()
}

/**
 * Normalize an email for dedupe: lowercase, trim, and fold the local part's
 * plus-address tag (`alex+sales@x.com` -> `alex@x.com`). Conservative: it does
 * NOT strip dots (Gmail-specific) since that isn't universal across providers.
 * Returns null for input without a single `@`.
 */
export function normalizeEmailKey(email: string | null | undefined): string | null {
  if (!email) return null
  const e = email.trim().toLowerCase()
  const at = e.indexOf('@')
  if (at <= 0 || at !== e.lastIndexOf('@') || at === e.length - 1) return null
  let local = e.slice(0, at)
  const domain = e.slice(at + 1)
  const plus = local.indexOf('+')
  if (plus >= 0) local = local.slice(0, plus)
  if (!local) return null
  return `${local}@${domain}`
}
