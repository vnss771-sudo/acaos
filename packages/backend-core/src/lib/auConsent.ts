// Spam Act 2003 (Cth) consent evidence — pure validation, no I/O.
//
// Rules encoded (Spam Act s16, Schedule 2 cl 2 & 4; ACMA "Avoid sending spam"):
//  - Legitimate interest is a GDPR concept and NEVER counts. Neither do the legacy
//    CASL bases (express_consent / implied_consent): they carry no Australian
//    evidence, so they do not satisfy this gate.
//  - Publication of an address is NOT consent by itself. An inference of consent
//    from conspicuous publication needs ALL of: the page URL, the date it was
//    seen, whether the address is a role address or the person's own, a verified
//    absence of any "no unsolicited commercial email" statement, and that the
//    message is relevant to the recipient's role.
//  - Express consent needs a documented record: when it was given and where/what
//    (a URL or a short excerpt).
//  - Anything missing or malformed fails closed (not qualifying).
// This is not legal advice; the copy and thresholds need independent review.

import { AU_CONSENT_BASES, AU_ADDRESS_TYPES } from './subprocessors.js'
import { isWellFormedHttpUrl } from './normalize.js'

export type AuConsentRow = {
  basis: string
  evidenceUrl?: string | null
  evidenceAt?: Date | string | null
  evidenceExcerpt?: string | null
  evidenceHash?: string | null
  addressType?: string | null
  optOutStatementAbsent?: boolean | null
  roleRelevant?: boolean | null
}

export type AuEvidenceResult = { ok: true } | { ok: false; reasons: string[] }

export function isAuConsentBasis(basis: string): boolean {
  return (AU_CONSENT_BASES as readonly string[]).includes(basis)
}

function validDate(v: Date | string | null | undefined, now: Date): boolean {
  if (!v) return false
  const d = v instanceof Date ? v : new Date(v)
  return !Number.isNaN(d.getTime()) && d.getTime() <= now.getTime()
}

export function validateAuConsentEvidence(row: AuConsentRow, now: Date = new Date()): AuEvidenceResult {
  const reasons: string[] = []
  if (!isAuConsentBasis(row.basis)) {
    return { ok: false, reasons: [`basis '${row.basis}' does not establish Spam Act consent`] }
  }
  if (!validDate(row.evidenceAt, now)) reasons.push('evidenceAt (date consent given / publication seen) is required and cannot be in the future')

  if (row.basis === 'express') {
    const hasUrl = typeof row.evidenceUrl === 'string' && isWellFormedHttpUrl(row.evidenceUrl)
    const hasExcerpt = typeof row.evidenceExcerpt === 'string' && row.evidenceExcerpt.trim().length >= 10
    if (!hasUrl && !hasExcerpt) reasons.push('express consent needs documentation: an evidenceUrl or an evidenceExcerpt (>= 10 chars)')
  } else {
    if (!(typeof row.evidenceUrl === 'string' && isWellFormedHttpUrl(row.evidenceUrl))) reasons.push('evidenceUrl (page where the address was published) must be a well-formed http(s) URL')
    if (!(AU_ADDRESS_TYPES as readonly string[]).includes(row.addressType ?? '')) reasons.push("addressType must be 'role' or 'personal'")
    if (row.optOutStatementAbsent !== true) reasons.push('must be verified that no "no unsolicited commercial email" statement accompanies the address')
    if (row.roleRelevant !== true) reasons.push('must be verified that the message is relevant to the recipient\'s role')
  }
  return reasons.length ? { ok: false, reasons } : { ok: true }
}

export function isQualifyingAuConsent(row: AuConsentRow, now?: Date): boolean {
  return validateAuConsentEvidence(row, now).ok
}
