import { prisma } from './prisma.js'
import { appendSlugSuffix, buildWorkspaceSlugSeed, sanitizeWorkspaceSlug } from './validation.js'
import { ApiError } from './http.js'
import type { WorkspaceRole } from '@acaos/shared'

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

// ── Workspace RBAC ────────────────────────────────────────────────────────────
// "admin" means owner OR admin; "member" is the least-privileged role. High-risk
// actions (bulk import/export, destructive deletes, campaign/mission control,
// discovery/enrichment that spends provider quota) require at least admin.

const ROLE_RANK: Record<WorkspaceRole, number> = { member: 1, admin: 2, owner: 3 }

/** Map an arbitrary stored/fake role to a known role; unknown/missing → member. */
export function normalizeWorkspaceRole(role: string | null | undefined): WorkspaceRole {
  return role === 'owner' || role === 'admin' ? role : 'member'
}

/** The caller's normalized role in a workspace, or null if not a member. */
export async function getWorkspaceRole(userId: string, workspaceId: string): Promise<WorkspaceRole | null> {
  const membership = await prisma.membership.findFirst({
    where: { userId, workspaceId },
    select: { role: true }
  })
  return membership ? normalizeWorkspaceRole(membership.role) : null
}

/**
 * Authorize a workspace action by minimum role. Verifies membership AND role in
 * one check — use it in place of `userHasWorkspaceAccess` on privileged routes.
 * Throws 403 when the caller is not a member or is below `min`. Returns the role.
 */
export async function assertMinimumWorkspaceRole(
  userId: string,
  workspaceId: string,
  min: WorkspaceRole
): Promise<WorkspaceRole> {
  const role = await getWorkspaceRole(userId, workspaceId)
  if (!role || ROLE_RANK[role] < ROLE_RANK[min]) {
    throw new ApiError(403, 'Admin role required')
  }
  return role
}
