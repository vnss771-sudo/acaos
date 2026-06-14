import { prisma } from './prisma.js'
import { appendSlugSuffix, buildWorkspaceSlugSeed, sanitizeWorkspaceSlug } from './validation.js'

export async function resolveUniqueWorkspaceSlug(name: string | undefined, email: string) {
  const base = buildWorkspaceSlugSeed(name, email)

  const existingBase = await prisma.workspace.findUnique({ where: { slug: base } })
  if (!existingBase) return base

  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const candidate = appendSlugSuffix(base, attempt)
    const existing = await prisma.workspace.findUnique({ where: { slug: candidate } })
    if (!existing) return candidate
  }

  return appendSlugSuffix(base, Date.now())
}

export async function ensureWorkspaceSlug(input: string, excludeId?: string) {
  const base = sanitizeWorkspaceSlug(input)
  if (!base) {
    throw new Error('Workspace slug must contain letters or numbers')
  }

  const existingBase = await prisma.workspace.findFirst({
    where: { slug: base, ...(excludeId ? { id: { not: excludeId } } : {}) }
  })
  if (!existingBase) return base

  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const candidate = appendSlugSuffix(base, attempt)
    const existing = await prisma.workspace.findFirst({
      where: { slug: candidate, ...(excludeId ? { id: { not: excludeId } } : {}) }
    })
    if (!existing) return candidate
  }

  return appendSlugSuffix(base, Date.now())
}

// Alias used by leads/campaigns routes
export async function userBelongsToWorkspace(userId: string, workspaceId: string) {
  return userHasWorkspaceAccess(userId, workspaceId)
}

export async function userHasWorkspaceAccess(userId: string, workspaceId: string) {
  const membership = await prisma.membership.findFirst({
    where: { userId, workspaceId },
    select: { id: true }
  })

  return Boolean(membership)
}

export async function userCanManageWorkspaceBilling(userId: string, workspaceId: string) {
  const membership = await prisma.membership.findFirst({
    where: {
      userId,
      workspaceId,
      role: { in: ['owner', 'admin'] }
    },
    select: { id: true }
  })

  return Boolean(membership)
}
