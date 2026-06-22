import { prisma } from './prisma.js'
import { appendSlugSuffix, buildWorkspaceSlugSeed, sanitizeWorkspaceSlug } from './validation.js'
import { ApiError } from './http.js'
import { createTtlCache } from './ttlCache.js'
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
  return (await getWorkspaceRole(userId, workspaceId)) !== null
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

/** Non-throwing role comparison: does `role` meet at least `min` in the hierarchy? */
export function roleMeetsMinimum(role: WorkspaceRole, min: WorkspaceRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min]
}

// Membership role cache. After the JWT auth lookup, nearly every authed request
// checks workspace membership — historically a second per-request DB round-trip
// on the entire data surface (leads, prospects, stats, intelligence, …). This
// short-TTL, single-flight cache removes that round-trip (concurrent checks for
// the same pair also collapse to one query). Keyed by `${userId}:${workspaceId}`;
// it caches the normalized role OR null (non-member), so repeated denials don't
// re-hit the DB either.
//
// Correctness: membership changes are rare and we invalidate the exact key on
// every add/remove (see invalidateWorkspaceMembership call sites). The only
// residual staleness is the <= TTL window after a membership change made by a
// path that forgets to invalidate (or a direct DB edit) — bounded and small.
const MEMBERSHIP_TTL_MS = 5_000
const roleCache = createTtlCache<WorkspaceRole | null>(MEMBERSHIP_TTL_MS)

function membershipKey(userId: string, workspaceId: string) {
  return `${userId}:${workspaceId}`
}

/**
 * Drop the cached membership role for a (user, workspace) pair. MUST be called
 * after any membership create/delete so the next authorization check is accurate
 * (e.g. a removed member is denied immediately, an added member is admitted).
 */
export function invalidateWorkspaceMembership(userId: string, workspaceId: string): void {
  roleCache.delete(membershipKey(userId, workspaceId))
}

async function loadWorkspaceRole(userId: string, workspaceId: string): Promise<WorkspaceRole | null> {
  const membership = await prisma.membership.findFirst({
    where: { userId, workspaceId },
    select: { role: true }
  })
  return membership ? normalizeWorkspaceRole(membership.role) : null
}

/** The caller's normalized role in a workspace, or null if not a member. Cached. */
export async function getWorkspaceRole(userId: string, workspaceId: string): Promise<WorkspaceRole | null> {
  return roleCache.get(membershipKey(userId, workspaceId), () => loadWorkspaceRole(userId, workspaceId))
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
