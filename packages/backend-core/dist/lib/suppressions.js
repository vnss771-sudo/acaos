import { prisma } from './prisma.js';
export async function isSuppressed(workspaceId, email) {
    const hit = await prisma.suppression.findUnique({
        where: { workspaceId_email: { workspaceId, email: email.toLowerCase().trim() } }
    });
    return hit !== null;
}
export async function suppress(workspaceId, email, reason = 'UNSUBSCRIBED') {
    await prisma.suppression.upsert({
        where: { workspaceId_email: { workspaceId, email: email.toLowerCase().trim() } },
        create: { workspaceId, email: email.toLowerCase().trim(), reason },
        update: { reason }
    });
}
/**
 * Resolve which of `emails` are suppressed for a workspace and return a predicate
 * that normalizes its argument before checking. Returning a predicate (rather than
 * a raw Set of already-normalized addresses) removes a footgun: callers used to be
 * able to do `set.has(rawMixedCaseEmail)` and get a false negative, sending to a
 * suppressed address. Now the normalization lives on both sides of the comparison.
 */
export async function bulkCheckSuppression(workspaceId, emails) {
    const normalised = emails.map(e => e.toLowerCase().trim());
    const hits = await prisma.suppression.findMany({
        where: { workspaceId, email: { in: normalised } },
        select: { email: true }
    });
    const set = new Set(hits.map((h) => h.email));
    return (email) => set.has(email.toLowerCase().trim());
}
