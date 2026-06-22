import type { WorkspaceRole } from '@acaos/shared'
import { ApiError } from './http.js'
import { getWorkspaceRole } from './workspaces.js'

// ── Workspace RBAC permission matrix ──────────────────────────────────────────
// The single, explicit source of truth for "which role can perform which named
// workspace action". Previously these decisions were scattered across routes as
// inline `prisma.membership.findFirst({ role: { in: ['owner','admin'] } })` and
// `role: 'owner'` checks, which is easy to get subtly wrong or let drift. Routes
// now call assertWorkspacePermission(userId, workspaceId, '<capability>') and the
// allowed roles live here, auditable in one place.
//
// (Generic "any data-mutating action needs at least admin" stays expressed as
// assertMinimumWorkspaceRole(..., 'admin') in workspaces.ts — a rank gate over
// the same role model. This matrix covers the specific named capabilities.)

export type Permission =
  // admin+ capabilities
  | 'workspace:update'
  | 'workspace:seed'
  | 'members:manage'
  | 'billing:manage'
  | 'email_config:manage'
  | 'api_keys:manage'
  | 'icp:update'
  | 'mail:send_test'
  // admin+ action capabilities (resource-spending / shared-state mutations)
  | 'campaign:create'
  | 'campaign:update'
  | 'campaign:send'
  | 'campaign:retry_failed'
  | 'campaign:delete'
  | 'campaign:approve_draft'
  | 'leads:import'
  | 'leads:delete'
  | 'prospects:discover'
  | 'prospects:import'
  | 'prospects:delete'
  // owner-only capabilities
  | 'members:grant_admin'
  | 'members:remove'
  | 'model:reset'

// Built additively so higher roles inherit everything below them:
// member ⊂ admin ⊂ owner. Today members hold no named capability (their data
// access is governed by plain membership + assertMinimumWorkspaceRole), so the
// member set is empty by design.
const MEMBER_PERMISSIONS: Permission[] = []

const ADMIN_PERMISSIONS: Permission[] = [
  ...MEMBER_PERMISSIONS,
  'workspace:update',
  'workspace:seed',
  'members:manage',
  'billing:manage',
  'email_config:manage',
  'api_keys:manage',
  'icp:update',
  'mail:send_test',
  // Action capabilities — each mirrors the admin role gate the route enforces
  // today (campaign control, bulk import, discovery that spends provider quota).
  'campaign:create',
  'campaign:update',
  'campaign:send',
  'campaign:retry_failed',
  'campaign:delete',
  'campaign:approve_draft',
  'leads:import',
  'leads:delete',
  'prospects:discover',
  'prospects:import',
  'prospects:delete',
]

const OWNER_PERMISSIONS: Permission[] = [
  ...ADMIN_PERMISSIONS,
  'members:grant_admin',
  'members:remove',
  'model:reset',
]

export const ROLE_PERMISSIONS: Record<WorkspaceRole, ReadonlySet<Permission>> = {
  member: new Set(MEMBER_PERMISSIONS),
  admin: new Set(ADMIN_PERMISSIONS),
  owner: new Set(OWNER_PERMISSIONS),
}

/** Does this role hold the given permission? A null role (non-member) holds none. */
export function roleCan(role: WorkspaceRole | null | undefined, permission: Permission): boolean {
  return role ? ROLE_PERMISSIONS[role].has(permission) : false
}

/**
 * Authorize a workspace action by capability. Resolves the caller's role (cached)
 * and checks the matrix; throws 403 when the caller is not a member or the role
 * lacks the permission. Returns the caller's role for any follow-on capability
 * checks (e.g. members:manage then members:grant_admin).
 */
export async function assertWorkspacePermission(
  userId: string,
  workspaceId: string,
  permission: Permission,
): Promise<WorkspaceRole> {
  const role = await getWorkspaceRole(userId, workspaceId)
  if (!roleCan(role, permission)) {
    throw new ApiError(403, `Forbidden: requires '${permission}'`)
  }
  return role as WorkspaceRole
}
