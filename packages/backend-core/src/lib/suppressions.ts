import { prisma } from './prisma.js'

export async function isSuppressed(workspaceId: string, email: string): Promise<boolean> {
  const hit = await prisma.suppression.findUnique({
    where: { workspaceId_email: { workspaceId, email: email.toLowerCase().trim() } }
  })
  return hit !== null
}

export async function suppress(workspaceId: string, email: string, reason: 'UNSUBSCRIBED' | 'BOUNCED' | 'MANUAL' = 'UNSUBSCRIBED') {
  await prisma.suppression.upsert({
    where: { workspaceId_email: { workspaceId, email: email.toLowerCase().trim() } },
    create: { workspaceId, email: email.toLowerCase().trim(), reason },
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
  const normalised = emails.map(e => e.toLowerCase().trim())
  const hits = await prisma.suppression.findMany({
    where: { workspaceId, email: { in: normalised } },
    select: { email: true }
  })
  const set = new Set((hits as Array<{ email: string }>).map((h: { email: string }) => h.email))
  return (email: string) => set.has(email.toLowerCase().trim())
}
