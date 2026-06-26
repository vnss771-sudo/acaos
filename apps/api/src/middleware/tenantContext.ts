import type { Request, Response, NextFunction } from 'express'
import { runInWorkspaceContext } from '@acaos/backend-core/lib/tenantContext.js'
import { tenantGuardMode } from '@acaos/backend-core/lib/tenantGuard.js'

// Establish the per-request tenant context so the defense-in-depth tenant guard
// (tenantGuard.ts, wired in prisma.ts) actually covers the API — without this the
// guard only ever saw worker jobs (which already run inside runInWorkspaceContext),
// and every API query was classified 'skipped' for lack of a context.
//
// The workspace a request operates on is taken from the request's own workspaceId
// (query or body) — the value routes already validate + authorize. It is the
// "claimed" workspace; the guard then verifies that the queries the handler runs are
// actually scoped to it, so a handler that strays to another workspace is flagged
// (observe) or rejected (enforce). Resource-id-only routes (e.g. /campaigns/:id,
// where the workspace is derived from the resource) carry no request workspaceId and
// fall through uncovered for now — the fetch-then-authorize pattern remains their
// control; wrapping those handlers explicitly is the next coverage step.
//
// A strict no-op when the guard is off (the default), so it adds nothing to the hot
// path until an operator turns the guard on.

function resolveWorkspaceId(req: Request): string | undefined {
  const q = req.query?.workspaceId
  if (typeof q === 'string' && q.length > 0) return q
  const body = req.body
  if (body && typeof body === 'object') {
    const b = (body as Record<string, unknown>).workspaceId
    if (typeof b === 'string' && b.length > 0) return b
  }
  return undefined
}

export function tenantContext(req: Request, _res: Response, next: NextFunction): void {
  if (tenantGuardMode() === 'off') return next()
  const workspaceId = resolveWorkspaceId(req)
  if (!workspaceId) return next()
  // runInWorkspaceContext invokes next() synchronously inside the AsyncLocalStorage
  // context; the context then propagates across the handler's awaits.
  runInWorkspaceContext(workspaceId, () => next())
}
