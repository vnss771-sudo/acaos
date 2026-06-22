import { emailDomain } from './sendPacing.js'

// Disposable / throwaway email blocking for signup. The classic platform-abuse
// vector is registering many accounts from temp-mail services (mailinator,
// 10minutemail, …) to send spam, evade suppression, or farm free quota. Rejecting
// known-disposable domains at signup raises the cost of that attack with near-zero
// false positives — no legitimate SaaS account uses a 10-minute mailbox.
//
// Enabled by DEFAULT (BLOCK_DISPOSABLE_EMAILS, default true) since the blast radius
// is limited to well-known throwaway domains; an operator can disable it or extend
// the list (DISPOSABLE_EMAIL_DOMAINS, comma-separated) without a deploy.

// Curated set of well-known disposable mailbox providers. Conservative on purpose.
const BUILTIN_DISPOSABLE: ReadonlySet<string> = new Set([
  'mailinator.com', '10minutemail.com', '10minutemail.net', 'guerrillamail.com',
  'guerrillamail.info', 'guerrillamail.net', 'guerrillamail.org', 'guerrillamail.biz',
  'sharklasers.com', 'grr.la', 'spam4.me', 'trashmail.com', 'trashmail.net',
  'yopmail.com', 'yopmail.net', 'yopmail.fr', 'temp-mail.org', 'tempmail.com',
  'tempmailo.com', 'getnada.com', 'nada.email', 'dispostable.com', 'maildrop.cc',
  'throwawaymail.com', 'fakeinbox.com', 'mailnesia.com', 'mintemail.com',
  'mohmal.com', 'tempinbox.com', 'emailondeck.com', 'spamgourmet.com',
  'mailcatch.com', 'discard.email', 'tempr.email', 'moakt.com', 'getairmail.com',
  'inboxkitten.com', '33mail.com', 'mailsac.com', 'mailedu.de', 'einrot.com',
  'fakemail.net', 'tmail.ws', 'tmpmail.org', 'tmpmail.net', 'burnermail.io',
  'mytemp.email', 'wegwerfmail.de', 'mvrht.net',
])

// Parse the operator-supplied extra domains (DISPOSABLE_EMAIL_DOMAINS) live. Each
// entry is normalized (trim, lowercase, strip a leading '@' or '.').
function extraDisposableDomains(): Set<string> {
  const raw = process.env.DISPOSABLE_EMAIL_DOMAINS
  if (!raw) return new Set()
  return new Set(
    raw.split(',').map((s) => s.trim().toLowerCase().replace(/^[@.]+/, '')).filter(Boolean),
  )
}

/** Whether enforcement is enabled (default true; set BLOCK_DISPOSABLE_EMAILS=false to disable). */
export function disposableBlockingEnabled(): boolean {
  const raw = (process.env.BLOCK_DISPOSABLE_EMAILS || '').trim().toLowerCase()
  if (raw === 'false' || raw === '0' || raw === 'no' || raw === 'off') return false
  return true
}

/**
 * Whether a domain is a known disposable provider — matching the exact domain or
 * any subdomain of it (throwaway services hand out many subdomains). Pure.
 */
export function isDisposableDomain(domain: string | null | undefined): boolean {
  if (!domain) return false
  const d = domain.trim().toLowerCase()
  if (!d) return false
  const extra = extraDisposableDomains()
  for (const bad of [...BUILTIN_DISPOSABLE, ...extra]) {
    if (d === bad || d.endsWith(`.${bad}`)) return true
  }
  return false
}

/** Whether an email address uses a known disposable domain. */
export function isDisposableEmail(email: string | null | undefined): boolean {
  return isDisposableDomain(emailDomain(email ?? ''))
}
