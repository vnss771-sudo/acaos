import { prisma } from './prisma.js'
import { normalizeEmail } from './normalize.js'

// Per-recipient consent-record lookups (ConsentRecord), mirroring suppressions.ts:
// every check matches on the normalized emailKey via one normalizer, so both sides
// of the comparison agree — a mixed-case or whitespace-padded address can never
// produce a false positive ("has consent" when it doesn't) or false negative.

export async function hasConsent(workspaceId: string, email: string): Promise<boolean> {
  const hit = await prisma.consentRecord.findFirst({
    where: { workspaceId, emailKey: normalizeEmail(email) },
    select: { id: true },
  })
  return hit !== null
}

/**
 * Resolve which of `emails` have an on-file ConsentRecord for a workspace and
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
    where: { workspaceId, emailKey: { in: keys } },
    select: { emailKey: true },
  })
  const set = new Set((hits as Array<{ emailKey: string }>).map((h: { emailKey: string }) => h.emailKey))
  return (email: string) => set.has(normalizeEmail(email))
}
