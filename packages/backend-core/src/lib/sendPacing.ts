// Per-recipient-domain send pacing. Mailbox providers (Gmail, Outlook, …) throttle
// or temp-block a sender that bursts too many messages to their domain at once, so
// a campaign heavy on one provider can torch deliverability even while the
// workspace-wide daily cap is fine. This caps sends to any single recipient domain
// per UTC day.
//
// OPT-IN: disabled unless PER_DOMAIN_DAILY_CAP is set to a positive integer, so
// existing send behaviour is unchanged by default. Advisory (not a hard atomic
// invariant like the workspace daily cap): a small overshoot across concurrent
// batches is acceptable for pacing.

/**
 * The per-domain daily cap, or null when pacing is disabled. PER_DOMAIN_DAILY_CAP
 * must be a positive integer; anything else (unset/0/negative/garbage) → disabled.
 * Read live so it can change without a deploy.
 */
export function perDomainDailyCap(): number | null {
  const n = Number(process.env.PER_DOMAIN_DAILY_CAP)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

/** The lowercased domain part of an email (after the last '@'), or null. */
export function emailDomain(email: string | null | undefined): string | null {
  if (!email) return null
  const at = email.lastIndexOf('@')
  if (at < 0) return null
  const d = email.slice(at + 1).trim().toLowerCase()
  return d.length > 0 ? d : null
}

/**
 * Tally a list of recipient emails into per-domain counts. Used to seed the
 * pacing counter from the day's existing sends before a batch starts. Pure.
 */
export function tallyDomains(emails: Array<string | null | undefined>): Map<string, number> {
  const counts = new Map<string, number>()
  for (const e of emails) {
    const d = emailDomain(e)
    if (d) counts.set(d, (counts.get(d) ?? 0) + 1)
  }
  return counts
}
