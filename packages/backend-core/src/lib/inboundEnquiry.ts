// Inbound job enquiries: email that arrives at the connected mailbox from
// someone who is NOT a lead and is NOT replying to our outreach — "can you
// quote for a switchboard upgrade?". For a contractor that is the warmest work
// there is, and the mailbox sync used to record it as "unmatched" and drop it.
//
// This module decides, deterministically (no AI, no I/O), whether such an email
// is a person asking for work, scores it 0–100 and says why in plain language,
// exactly like opportunityMatch does for tenders and DAs. A surfaced enquiry is
// persisted as an Opportunity (source "email", kind DIRECT_ENQUIRY) so the whole
// Find work → Pursue → Quote → Won → Job → Margin loop applies unchanged, and
// "what each kind of work earns" can compare direct enquiries with tenders.
//
// Bias: automated and bulk mail is filtered on hard evidence (headers, sender
// mailbox, transactional/marketing phrasing); a person's email then needs at
// least one sign they want work done. A false positive costs one Dismiss click;
// a missed job costs the job — but a Find work list full of receipts would be
// ignored, so every surfaced card must carry a stated reason.

import { assessRisk, RISK_FLAG_LABEL, type RiskFlag } from './riskEscalation.js'
import { TRADES, findKeyword, type TradeId } from './opportunityTaxonomy.js'

export const ENQUIRY_SOURCE = 'email'
export const ENQUIRY_KIND = 'DIRECT_ENQUIRY'
/** Stored description cap: enough to read the ask, not an archive of the mailbox. */
export const ENQUIRY_EXCERPT_MAX = 600

export type InboundEmail = {
  fromAddress: string
  fromName?: string | null
  subject: string
  /** Fresh body text, quoted history already stripped. */
  body: string
  /** Lower-cased header name → value. */
  headers: Record<string, string>
  /** The mailbox's own address(es): mail from ourselves is never an enquiry. */
  ownAddresses: string[]
}

export type EnquiryAssessment =
  | { enquiry: false; reason: string }
  | {
      enquiry: true
      score: number
      reasons: string[]
      recommendedAction: string
      matchedTrades: TradeId[]
      riskFlags: RiskFlag[]
      phone: string | null
      region?: string
      postcode?: string
    }

const AUTOMATED_SENDER = /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounces?|notifications?|notify|alerts?|newsletters?|news|marketing|promo(tions)?|updates|info-?noreply|system|automated)([+._-].*)?@/

// Transactional / marketing / platform mail a person didn't write to us.
const NOT_A_PERSON = [
  /\b(unsubscribe|view (this|it) in (your|a) browser|manage (your )?(email )?preferences)\b/,
  /\b(order confirmation|your order|has (been )?shipped|tracking number|payment (received|confirmed|successful)|receipt for|tax invoice attached|your invoice is ready|remittance advice)\b/,
  /\b(verify your (email|account)|password reset|reset your password|sign-?in attempt|security code|one-time (pass)?code|verification code)\b/,
  /\b(webinar|special offer|limited time|% off|free trial|guest post|backlinks|seo services|claim your|you have been selected|crypto|casino)\b/,
]

const QUOTE = /\b(quotes?|quotation|price|pricing|cost|costs|estimate|how much|rates?)\b/
const AVAILABILITY = /\b(availability|available|book (in|a time)|come (out|over|and (look|see|have a look))|take a look|have a look|site visit|inspect(ion)?|when (can|could) you|fit (me|us) in)\b/
const WORK_NEED = /\b(install(ation|ed|ing)?|repairs?|fix(ed|ing)?|replac(e|ed|ing|ement)|leak(ing|s)?|broken|not working|stopped working|renovat\w*|upgrade|service|maintenance|fit-?out|extension)\b/
const ASKING = /\b(need|needs|needing|looking for|after (a|an|some)|require|requires|want|wanting|would like|can you|could you|do you)\b/
const URGENT = /\b(urgent(ly)?|asap|emergency|today|tonight|tomorrow|this week|straight away|immediately)\b/
const ADDRESS = /\b\d{1,5}[a-z]?\s+[a-z][a-z' -]{1,40}\s(st|street|rd|road|ave|avenue|dr|drive|ct|court|cres|crescent|pl|place|pde|parade|hwy|highway|ln|lane|tce|terrace|blvd|way)\b/
// A state code only counts with a postcode after it ("VIC 3121"): bare "act",
// "sa" or a lone 4-digit number ("2024") are ordinary words and years.
const REGION_POSTCODE = /\b(act|nsw|nt|qld|sa|tas|vic|wa)\s*,?\s*(\d{4})\b/
const AU_PHONE = /(?<!\d)(?:\+61[\s-]?|\(?0)[2-478]\)?(?:[\s-]?\d){8}\b/

/** The Opportunity row persisted for a surfaced enquiry (mail sync builds it). */
export type EnquiryRecord = {
  externalId: string
  kind: string
  title: string
  description?: string | null
  region?: string | null
  postcode?: string | null
  publishedAt?: Date
  counterpartyName: string
  counterpartyEmail: string
  counterpartyPhone?: string | null
  score: number
  matchedTrades: string[]
  reasons: string[]
  recommendedAction: string
  rawData?: { messageId: string | null; riskFlags: string[] }
  contentHash: string
}

/** Mask payment-card numbers (Luhn-valid 13–19 digit runs) before anything is stored. */
export function redactSensitive(text: string): string {
  return text.replace(/\b(?:\d[ -]?){12,18}\d\b/g, m => (luhnValid(m) ? '[card number removed]' : m))
}

function luhnValid(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, '')
  if (digits.length < 13 || digits.length > 19) return false
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9 }
    sum += d
  }
  return sum % 10 === 0
}

/** The text stored as the Opportunity description: whitespace-collapsed, redacted, capped. */
export function enquiryExcerpt(body: string): string {
  const flat = redactSensitive(body.replace(/\s+/g, ' ').trim())
  return flat.length > ENQUIRY_EXCERPT_MAX ? `${flat.slice(0, ENQUIRY_EXCERPT_MAX - 1).trimEnd()}…` : flat
}

function automatedHeaderReason(h: Record<string, string>): string | null {
  const auto = (h['auto-submitted'] ?? '').trim().toLowerCase()
  if (auto && auto !== 'no') return 'auto-submitted'
  if (/\b(bulk|list|junk|auto_reply)\b/i.test(h['precedence'] ?? '')) return 'bulk precedence'
  if (h['list-unsubscribe'] || h['list-id']) return 'mailing list'
  if (h['x-autoreply'] || h['x-autorespond'] || /\b(all|oof|autoreply)\b/i.test(h['x-auto-response-suppress'] ?? '')) return 'auto-reply'
  return null
}

export function assessInboundEnquiry(m: InboundEmail): EnquiryAssessment {
  const from = m.fromAddress.trim().toLowerCase()
  if (!from) return { enquiry: false, reason: 'no sender' }
  if (m.ownAddresses.some(a => a.trim().toLowerCase() === from)) return { enquiry: false, reason: 'own address' }
  if (AUTOMATED_SENDER.test(from)) return { enquiry: false, reason: 'automated sender' }
  const headerReason = automatedHeaderReason(m.headers)
  if (headerReason) return { enquiry: false, reason: headerReason }

  const text = `${m.subject}\n${m.body}`.toLowerCase()
  if (NOT_A_PERSON.some(re => re.test(text))) return { enquiry: false, reason: 'transactional or marketing' }

  const risk = assessRisk(text)
  const quote = QUOTE.test(text)
  const availability = AVAILABILITY.test(text)
  const workNeed = WORK_NEED.test(text) && ASKING.test(text)
  const trades = TRADES.filter(t => findKeyword(text, t.keywords)).map(t => t.id)
  // A trade word alone ("electrical") is not an ask; it needs a request around it.
  const tradeAsk = trades.length > 0 && ASKING.test(text)

  if (!risk.escalate && !quote && !availability && !workNeed && !tradeAsk) {
    return { enquiry: false, reason: 'no request for work' }
  }

  const reasons: string[] = []
  let score = 40
  if (quote) { score += 20; reasons.push('Asks for a quote or price') }
  if (availability) { score += 10; reasons.push('Asks when you can come out') }
  if (workNeed && !quote) reasons.push('Describes work they need done')
  if (trades.length > 0) {
    score += 10
    const labels = trades.map(id => TRADES.find(t => t.id === id)!.label.toLowerCase())
    reasons.push(`Mentions ${labels.slice(0, 2).join(' and ')} work`)
  }
  if (URGENT.test(text)) { score += 10; reasons.push('Says it is urgent') }
  const rp = text.match(REGION_POSTCODE)
  const where = rp ? { region: rp[1].toUpperCase(), postcode: rp[2] } : null
  if (ADDRESS.test(text) || where) { score += 5; reasons.push('Gives a location') }
  const phone = m.body.match(AU_PHONE)?.[0]?.trim() ?? null
  if (phone) { score += 5; reasons.push('Left a phone number') }

  let recommendedAction = phone ? 'Call them back today — direct enquiries go to whoever answers first.' : 'Reply today — direct enquiries go to whoever answers first.'
  if (risk.escalate) {
    // Not necessarily new work — often an existing customer with a problem. It
    // still has to be seen first, so it sorts to the top, and no automation
    // (AI drafting) may act on it.
    score = 100
    reasons.unshift(...risk.flags.map(f => `Needs you personally: ${RISK_FLAG_LABEL[f].toLowerCase()}`))
    recommendedAction = 'Handle this yourself — read the full email and respond personally. Nothing will be drafted for it.'
  }

  return {
    enquiry: true,
    score: Math.min(100, score),
    reasons,
    recommendedAction,
    matchedTrades: trades,
    riskFlags: risk.flags,
    phone,
    ...(where ?? {}),
  }
}

/** Lower-cased header map from a raw RFC 5322 message (header block only, folded lines joined). */
export function parseHeaderBlock(source: Buffer | string): Record<string, string> {
  const raw = typeof source === 'string' ? source.slice(0, 64_000) : source.toString('utf-8', 0, 64_000)
  const end = raw.search(/\r?\n\r?\n/)
  const block = (end === -1 ? raw : raw.slice(0, end)).replace(/\r?\n[ \t]+/g, ' ')
  const out: Record<string, string> = {}
  for (const line of block.split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    const name = line.slice(0, i).trim().toLowerCase()
    if (!(name in out)) out[name] = line.slice(i + 1).trim()
  }
  return out
}
