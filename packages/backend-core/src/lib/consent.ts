import { prisma } from './prisma.js'
import { normalizeEmail } from './normalize.js'
import { AU_CONSENT_BASES } from './subprocessors.js'
import { isQualifyingAuConsent } from './auConsent.js'

// Per-recipient consent-record lookups (ConsentRecord), mirroring suppressions.ts:
// every check matches on the normalized emailKey via one normalizer, so both sides
// of the comparison agree — a mixed-case or whitespace-padded address can never
// produce a false positive ("has consent" when it doesn't) or false negative.

// Only these bases satisfy a consent gate. 'legitimate_interest' (a GDPR concept)
// is recorded in the ledger but never authorises a send under CASL or the Spam Act.
export const CONSENT_QUALIFYING_BASES: readonly string[] = ['express_consent', 'implied_consent']

export async function hasConsent(workspaceId: string, email: string): Promise<boolean> {
  const hit = await prisma.consentRecord.findFirst({
    where: { workspaceId, emailKey: normalizeEmail(email), basis: { in: [...CONSENT_QUALIFYING_BASES] } },
    select: { id: true },
  })
  return hit !== null
}

/**
 * Resolve which of `emails` have an on-file, qualifying-basis ConsentRecord for a workspace and
 * return a predicate that normalizes its argument before checking — same shape
 * and rationale as bulkCheckSuppression: a raw Set keyed on un-normalized
 * addresses is a footgun once a caller does `set.has(rawMixedCaseEmail)`.
 */
export async function bulkCheckConsent(
  workspaceId: string,
  emails: string[],
): Promise<(email: string) => boolean> {
  const keys = emails.map(normalizeEmail)
  const hits = await prisma.consentRecord.findMany({
    where: { workspaceId, emailKey: { in: keys }, basis: { in: [...CONSENT_QUALIFYING_BASES] } },
    select: { emailKey: true },
  })
  const set = new Set((hits as Array<{ emailKey: string }>).map((h: { emailKey: string }) => h.emailKey))
  return (email: string) => set.has(normalizeEmail(email))
}

// ── Spam Act 2003 (Australia) ────────────────────────────────────────────────
// A row counts only if its basis is an AU basis AND its Schedule 2 evidence
// validates. Legacy CASL/GDPR rows (express_consent, implied_consent,
// legitimate_interest) never satisfy this check. Any one qualifying row suffices.

const AU_EVIDENCE_SELECT = {
  emailKey: true, basis: true, evidenceUrl: true, evidenceAt: true, evidenceExcerpt: true,
  evidenceHash: true, addressType: true, optOutStatementAbsent: true, roleRelevant: true,
} as const

export async function hasAuConsent(workspaceId: string, email: string): Promise<boolean> {
  const rows = await prisma.consentRecord.findMany({
    where: { workspaceId, emailKey: normalizeEmail(email), basis: { in: [...AU_CONSENT_BASES] } },
    select: AU_EVIDENCE_SELECT,
  })
  return (rows as Array<Parameters<typeof isQualifyingAuConsent>[0]>).some((r) => isQualifyingAuConsent(r))
}

export async function bulkCheckAuConsent(
  workspaceId: string,
  emails: string[],
): Promise<(email: string) => boolean> {
  const keys = emails.map(normalizeEmail)
  const rows = await prisma.consentRecord.findMany({
    where: { workspaceId, emailKey: { in: keys }, basis: { in: [...AU_CONSENT_BASES] } },
    select: AU_EVIDENCE_SELECT,
  })
  const ok = new Set<string>()
  for (const r of rows as Array<{ emailKey: string } & Parameters<typeof isQualifyingAuConsent>[0]>) {
    if (isQualifyingAuConsent(r)) ok.add(r.emailKey)
  }
  return (email: string) => ok.has(normalizeEmail(email))
}
