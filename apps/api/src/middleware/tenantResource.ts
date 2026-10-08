import type { RequestHandler } from 'express'
import { runInWorkspaceContext } from '@acaos/backend-core/lib/tenantContext.js'
import { asyncHandler, ApiError, requireUser } from '../lib/http.js'
import { getWorkspaceRole } from '../lib/workspaces.js'

export type TenantResourceScopeOptions = {
  /** Human-readable resource label used only for the indistinguishable 404. */
  resource: string
  /** Express route-param containing the resource id. Defaults to `id`. */
  param?: string
  /** Load only the ownership fact needed to establish tenant context. */
  loadWorkspace: (id: string) => Promise<{ workspaceId: string } | null>
}

/**
 * Establish tenant context for resource-id-only routes.
 *
 * Query/body-scoped routes already advertise their workspace through tenantContext.ts.
 * A route such as `/campaigns/:id` cannot do that until the id has been resolved.
 * This middleware resolves only the resource's workspace, verifies the authenticated
 * caller is a member, then invokes the remainder of the route stack inside the
 * AsyncLocalStorage tenant context. The downstream handler still owns action-level
 * RBAC (admin/owner/permission checks); this middleware supplies the universal
 * ownership boundary that must never be forgotten.
 *
 * A non-member receives the same 404 as a missing resource so an attacker cannot use
 * guessed ids to distinguish resources that exist in another workspace.
 */
export function tenantResourceScope(options: TenantResourceScopeOptions): RequestHandler {
  const param = options.param ?? 'id'
  return asyncHandler(async (req, _res, next) => {
    const user = requireUser(req)
    const id = String(req.params[param] ?? '').trim()
    if (!id) throw new ApiError(404, `${options.resource} not found`)

    const owned = await options.loadWorkspace(id)
    if (!owned) throw new ApiError(404, `${options.resource} not found`)

    const role = await getWorkspaceRole(user.id, owned.workspaceId)
    if (!role) {
      // Deliberately hide resource existence across tenant boundaries.
      throw new ApiError(404, `${options.resource} not found`)
    }

    // next() is invoked synchronously inside storage.run(); every async operation
    // started by the downstream Express handler inherits this workspace context.
    runInWorkspaceContext(owned.workspaceId, () => next())
  })
}
