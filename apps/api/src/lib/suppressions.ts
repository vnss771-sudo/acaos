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

export async function bulkCheckSuppression(workspaceId: string, emails: string[]): Promise<Set<string>> {
  const normalised = emails.map(e => e.toLowerCase().trim())
  const hits = await prisma.suppression.findMany({
    where: { workspaceId, email: { in: normalised } },
    select: { email: true }
  })
  return new Set(hits.map(h => h.email))
}
