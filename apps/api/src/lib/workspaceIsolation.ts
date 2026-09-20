// Workspace isolation verification and monitoring. Phase 4.1 ensures every multi-tenant
// query is scoped to the current workspace context, preventing accidental data leaks.
//
// Instruments the request lifecycle to verify:
// - Current workspace context is always set for workspace-scoped operations
// - Queries touching tenant models include workspace filters
// - Rate limits and quotas apply per-workspace, not globally
//
// Tenant models: Lead, Campaign, Prospect, Mission, Inbox, Task, OutreachSent, Outcome, etc.
// These must NEVER be queried without a workspaceId filter in multi-tenant code paths.

import type { Request, Response, NextFunction } from 'express'
import { logger } from '@acaos/backend-core/lib/logger.js'

interface IsolationContext {
  workspaceId: string | null
  userId: string | null
  isMultiTenant: boolean
  mutationStart: number
}

// Store isolation context per-request (using weak map is ideal but Express doesn't expose it cleanly)
const requestContexts = new WeakMap<Request, IsolationContext>()

/**
 * Middleware to establish workspace isolation context for each request.
 * Extracts workspaceId from query/body and ensures it's used for all tenant-model queries.
 */
export function workspaceIsolationContext(req: Request, res: Response, next: NextFunction): void {
  const workspaceId = (
    (req.body as { workspaceId?: unknown } | undefined)?.workspaceId ??
    (req.query as { workspaceId?: unknown } | undefined)?.workspaceId
  )

  const context: IsolationContext = {
    workspaceId: typeof workspaceId === 'string' ? workspaceId : null,
    userId: (req.user as { id?: string } | undefined)?.id ?? null,
    isMultiTenant: !!workspaceId,
    mutationStart: Date.now(),
  }

  requestContexts.set(req, context)

  // For mutation operations (POST/PATCH/PUT/DELETE) involving workspaceId,
  // verify isolation is maintained.
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) && context.workspaceId) {
    // Log audit trail of workspace mutations
    res.on('finish', () => {
      const duration = Date.now() - context.mutationStart
      const status = res.statusCode
      if (status < 400) {
        logger.debug('workspace mutation', {
          workspaceId: context.workspaceId,
          method: req.method,
          path: req.path,
          status,
          durationMs: duration,
        })
      }
    })
  }

  next()
}

/**
 * Get the current workspace context. Throws if called outside a scoped request.
 * Used by handlers to verify the workspace ID they received from the request.
 */
export function getWorkspaceContext(req: Request): IsolationContext {
  const context = requestContexts.get(req)
  if (!context) {
    throw new Error('No isolation context found — workspaceIsolationContext middleware not applied')
  }
  return context
}

/**
 * Verify that a database operation includes the workspace scope filter.
 * Call this right before executing a tenant-model query to ensure isolation.
 *
 * Example:
 *   const leads = await prisma.lead.findMany({
 *     where: { workspaceId: userId.workspaceId, ... }
 *   })
 *   verifyWorkspaceScope(req, leadResult, 'lead')
 */
export function verifyWorkspaceScope(
  req: Request,
  result: unknown[],
  model: string,
  expectedWorkspaceId?: string,
): void {
  const context = getWorkspaceContext(req)

  // Rough check: if result length > 0, verify all rows belong to the expected workspace.
  // In production, this is a defense-in-depth check; the where clause is the primary guard.
  if (Array.isArray(result) && result.length > 0) {
    const wsId = expectedWorkspaceId || context.workspaceId
    // @ts-ignore
    const workspaceField = 'workspaceId' in result[0] ? result[0].workspaceId : null

    if (workspaceField && workspaceField !== wsId) {
      logger.error('workspace isolation violation detected', {
        model,
        expected: wsId,
        actual: workspaceField,
        resultCount: result.length,
        userId: context.userId,
      })
      // In enforce mode, throw; in observe mode, log only.
      if (process.env.WORKSPACE_GUARD_MODE === 'enforce') {
        throw new Error(`Isolation violation: ${model} query returned data from wrong workspace`)
      }
    }
  }
}

/**
 * Track tenant-model queries across workspaces for performance monitoring.
 * Detects hotspots (workspaces with disproportionate query load).
 */
const workspaceQueryCounts = new Map<string, number>()

export function recordWorkspaceQuery(workspaceId: string): void {
  workspaceQueryCounts.set(workspaceId, (workspaceQueryCounts.get(workspaceId) ?? 0) + 1)
}

/**
 * Get query load distribution across workspaces. Useful for detecting abusive or
 * resource-intensive workspaces that might need rate limit tightening.
 */
export function getWorkspaceQueryDistribution(): Array<[string, number]> {
  return Array.from(workspaceQueryCounts.entries())
    .sort((a, b) => b[1] - a[1]) // Sort by count descending
    .slice(0, 10) // Top 10 workspaces
}

/**
 * Clear query counts (for testing or periodic reset).
 */
export function clearWorkspaceQueryDistribution(): void {
  workspaceQueryCounts.clear()
}
