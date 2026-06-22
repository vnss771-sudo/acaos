import { prisma } from './prisma.js'
import { normalizeEmail } from './normalize.js'

// All suppression matching keys on the normalized emailKey (trim+lowercase) via a
// single normalizer, so both sides of every comparison are normalized identically
// — a mixed-case or whitespace-padded address can never produce a false negative
// and send to a suppressed recipient.

export async function isSuppressed(workspaceId: string, email: string): Promise<boolean> {
  const hit = await prisma.suppression.findUnique({
    where: { workspaceId_emailKey: { workspaceId, emailKey: normalizeEmail(email) } }
  })
  return hit !== null
}

export async function suppress(workspaceId: string, email: string, reason: 'UNSUBSCRIBED' | 'BOUNCED' | 'MANUAL' | 'COMPLAINT' = 'UNSUBSCRIBED') {
  const emailKey = normalizeEmail(email)
  await prisma.suppression.upsert({
    // emailKey is the per-workspace unique key, so a re-suppression (e.g. a second
    // bounce, or a case variant) updates the existing row instead of duplicating.
    where: { workspaceId_emailKey: { workspaceId, emailKey } },
    create: { workspaceId, email: email.trim(), emailKey, reason },
    update: { reason }
  })
}

/**
 * Resolve which of `emails` are suppressed for a workspace and return a predicate
 * that normalizes its argument before checking. Returning a predicate (rather than
 * a raw Set of already-normalized addresses) removes a footgun: callers used to be
 * able to do `set.has(rawMixedCaseEmail)` and get a false negative, sending to a
 * suppressed address. Now the normalization lives on both sides of the comparison.
 */
export async function bulkCheckSuppression(
  workspaceId: string,
  emails: string[],
): Promise<(email: string) => boolean> {
  const keys = emails.map(normalizeEmail)
  const hits = await prisma.suppression.findMany({
    where: { workspaceId, emailKey: { in: keys } },
    select: { emailKey: true }
  })
  const set = new Set((hits as Array<{ emailKey: string }>).map((h: { emailKey: string }) => h.emailKey))
  return (email: string) => set.has(normalizeEmail(email))
}
