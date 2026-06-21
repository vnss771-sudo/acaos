// Single-flight TTL cache behind GET /api/stats, extracted into its own module
// so write-side routes can bust it on data changes WITHOUT importing the stats
// route file (which would create an import cycle).
//
// The dashboard summary is read-hot and fans out to ~7 aggregation queries. It
// is the steepest p99 climber under concurrency (see the load-test report), so
// we coalesce concurrent requests for the same workspace and serve the result
// for a short TTL. STATS_CACHE_TTL_MS=0 ⇒ pure single-flight (no stale reads).
//
// The TTL bounds staleness on its own, but it can still show numbers up to the
// TTL window old after a write. Workspace-scoped mutation sites therefore call
// invalidateWorkspaceStats() after a successful write (mirrors the membership
// cache's invalidateWorkspaceMembership pattern), so the next dashboard read
// recomputes immediately.
import { createTtlCache } from './ttlCache.js'

const STATS_CACHE_TTL_MS = Number(process.env.STATS_CACHE_TTL_MS ?? 5_000)

// Keyed by workspaceId. Authorization is checked per-request BEFORE this cache,
// so a cached payload is only ever returned to a verified member of that
// workspace.
export const statsCache = createTtlCache<Record<string, unknown>>(STATS_CACHE_TTL_MS)

/**
 * Drop the cached stats summary for a workspace. Call after any workspace-scoped
 * write that changes the dashboard numbers (lead create/update/delete/stage
 * change, bulk import, campaign/mission state, outcome writes) so the next
 * GET /api/stats recomputes instead of serving the pre-write snapshot.
 */
export function invalidateWorkspaceStats(workspaceId: string): void {
  statsCache.delete(workspaceId)
}
