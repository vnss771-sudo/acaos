// Request/job-scoped tenant context.
//
// Tenant isolation in ACAOS is currently "correct by convention": a route fetches a
// row, then calls userBelongsToWorkspace() to authorize it. That works, but one
// forgotten check is a cross-tenant leak. This AsyncLocalStorage context is the
// foundation for a defense-in-depth backstop (see tenantGuard.ts): code that runs
// inside runInWorkspaceContext(workspaceId, …) advertises "every DB access here must
// belong to this workspace", which the Prisma guard can then verify.
//
// The context propagates across awaits within the callback, so wrapping a single
// entrypoint (an API handler or a worker job) covers every query it makes — no
// per-query threading required. Outside any context (currentWorkspaceId() ===
// undefined), the guard is inert, so system/cross-workspace maintenance jobs are
// unaffected.

import { AsyncLocalStorage } from 'node:async_hooks'

interface TenantContextStore {
  workspaceId: string
}

const storage = new AsyncLocalStorage<TenantContextStore>()

/** Run `fn` with `workspaceId` as the active tenant context (propagates across awaits). */
export function runInWorkspaceContext<T>(workspaceId: string, fn: () => T): T {
  return storage.run({ workspaceId }, fn)
}

/** The workspace id of the active tenant context, or undefined if none is set. */
export function currentWorkspaceId(): string | undefined {
  return storage.getStore()?.workspaceId
}
