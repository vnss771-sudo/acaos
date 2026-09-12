// Defense-in-depth tenant-isolation guard (pure logic + mode resolver).
//
// Given an active tenant context (see tenantContext.ts), this classifies a Prisma
// operation on a tenant-owned model as:
//
//   - 'skipped'        — not our concern: non-tenant model, no active context, or a
//                        single-row op keyed by a unique id (the existing fetch-then-
//                        authorize pattern is the control for those).
//   - 'scoped'         — a multi-row read/write (or create) explicitly constrained by
//                        workspaceId === the context workspace. The safe case.
//   - 'scoped_via_fk'  — constrained by a tenant-owned foreign key (campaignId,
//                        leadId, …) instead of workspaceId directly. Legitimate (the
//                        FK belongs to the workspace) but worth distinguishing.
//   - 'unscoped'       — a multi-row read/write with NEITHER a workspaceId filter nor a
//                        tenant FK. This is the catastrophic class: a query that can
//                        cross tenant boundaries. The guard's reason to exist.
//
// Pure and deterministic — the Prisma extension in prisma.ts feeds it operations and
// acts on the verdict per TENANT_GUARD_MODE. Default mode is 'off' so wiring it in is
// zero-risk; 'observe' logs/counts 'unscoped' verdicts to build an inventory; 'enforce'
// throws. Enforcement is deliberately gated behind opt-in because FK-based scoping is
// legitimate and a blanket "must filter by workspaceId" would reject valid queries.

// Models carrying a workspaceId column (generated from schema.prisma; see the
// shared-enum-conformance style guard test that pins this list to the schema).
export const TENANT_MODELS: ReadonlySet<string> = new Set([
  'AiPromptVersion', 'AnalyticsEvent', 'AuditEvent', 'Campaign', 'CampaignDailyStats', 'ConsentRecord',
  'ContactEvent',
  'DiscoveryRun', 'EvidenceSource', 'FollowupTask', 'Lead', 'LeadEvidenceSource',
  'Membership', 'Mission',
  'OutreachDraft', 'OutreachIntent', 'OutreachSent', 'ProcessedEmail', 'Prospect',
  'ProspectOutcome', 'Recommendation', 'ScoringModel', 'ScoringOutcome', 'Signal',
  'Suppression', 'UnsubscribeEvent', 'UsageRecord', 'WorkspaceDraftPolicy',
  'WebhookEndpoint',
  'WorkspaceEmailConfig', 'WorkspaceICP', 'WorkspaceInvite',
])

// Tenant-owned foreign keys that transitively scope a query to a workspace: a row
// referencing one of these belongs to exactly one workspace. A query constrained by
// one of them is isolated even without a literal workspaceId filter.
export const TENANT_FOREIGN_KEYS: ReadonlyArray<string> = [
  'campaignId', 'leadId', 'missionId', 'prospectId', 'recommendationId',
  'outreachIntentId', 'outreachSentId', 'discoveryRunId', 'signalId',
]

// Single-row ops keyed by a unique where: they target at most one row by its unique
// id, so they can't carry a workspaceId filter. The fetch-then-authorize pattern (the
// row's workspaceId is checked after load) is the control for these; the guard does
// not second-guess them.
const SINGLE_ROW_OPS: ReadonlySet<string> = new Set([
  'findUnique', 'findUniqueOrThrow', 'update', 'delete', 'upsert',
])

// Ops the guard inspects: they read or mutate potentially many rows (or create new
// ones), so an absent tenant constraint can cross workspaces.
const GUARDED_OPS: ReadonlySet<string> = new Set([
  'findMany', 'findFirst', 'findFirstOrThrow', 'count', 'aggregate', 'groupBy',
  'updateMany', 'deleteMany', 'create', 'createMany',
])

export type TenantGuardMode = 'off' | 'observe' | 'enforce'

/** Resolve the guard mode from TENANT_GUARD_MODE (default 'off' — fully inert). */
export function tenantGuardMode(): TenantGuardMode {
  const v = (process.env.TENANT_GUARD_MODE || '').trim().toLowerCase()
  return v === 'observe' || v === 'enforce' ? v : 'off'
}

export type TenantAccessResult = 'skipped' | 'scoped' | 'scoped_via_fk' | 'unscoped'

/** True if a where-side workspaceId predicate pins the value to exactly `expected`
 *  (either `workspaceId: id` or `workspaceId: { equals: id }`). A broader predicate
 *  (in / not / unconstrained) is NOT treated as scoped. */
function matchesWorkspace(value: unknown, expected: string): boolean {
  if (value === expected) return true
  if (value !== null && typeof value === 'object') {
    const eq = (value as Record<string, unknown>).equals
    return eq === expected
  }
  return false
}

type SubtreeVerdict = 'scoped' | 'scoped_via_fk' | 'unscoped'

/**
 * Classify whether a where/data subtree is ITSELF soundly tenant-scoped. Bounded
 * depth so a pathological payload can't blow the stack.
 *
 * Combinator semantics matter here and are easy to get backwards:
 *   - AND narrows the result set — if any branch of an AND is scoped, the whole
 *     AND is scoped (the other branches can only restrict further).
 *   - OR widens the result set (it's a union) — a scoped branch says nothing
 *     about a sibling branch, so ALL branches must independently be scoped or
 *     the query can still cross the tenant boundary through the unscoped one.
 *   - NOT is an exclusion, not a positive constraint — `NOT: { workspaceId: x }`
 *     means "rows outside workspace x", the opposite of scoping to it. NOT is
 *     therefore never descended into for scoping evidence.
 *
 * The previous implementation (findKey) returned on the FIRST match of
 * workspaceId/a tenant FK anywhere in the tree, including inside an OR branch —
 * so `OR: [{ workspaceId: theirs }, { anythingAtAll }]` was certified "scoped"
 * by the first branch alone, even though the second branch can return any
 * workspace's rows. This walks every branch instead of stopping at the first hit.
 */
function classifySubtree(obj: unknown, workspaceId: string, depth = 0): SubtreeVerdict {
  if (depth > 6 || obj === null || typeof obj !== 'object' || Array.isArray(obj)) return 'unscoped'
  const rec = obj as Record<string, unknown>

  if (matchesWorkspace(rec.workspaceId, workspaceId)) return 'scoped'
  for (const fk of TENANT_FOREIGN_KEYS) {
    if (rec[fk] !== undefined) return 'scoped_via_fk'
  }

  if ('AND' in rec) {
    const branches = Array.isArray(rec.AND) ? rec.AND : [rec.AND]
    for (const branch of branches) {
      const verdict = classifySubtree(branch, workspaceId, depth + 1)
      if (verdict !== 'unscoped') return verdict
    }
  }

  if ('OR' in rec) {
    const branches = Array.isArray(rec.OR) ? rec.OR : [rec.OR]
    if (branches.length > 0) {
      const verdicts = branches.map((branch) => classifySubtree(branch, workspaceId, depth + 1))
      if (verdicts.every((v) => v !== 'unscoped')) {
        return verdicts.every((v) => v === 'scoped') ? 'scoped' : 'scoped_via_fk'
      }
    }
  }

  // NOT deliberately not descended into — see doc comment above.
  return 'unscoped'
}

/**
 * Classify a Prisma operation against the active tenant context. Pure.
 *
 * @param model       Prisma model name (e.g. 'Lead'), or undefined for raw ops.
 * @param operation   Prisma operation (e.g. 'findMany').
 * @param args        The operation args ({ where }, { data }, …).
 * @param workspaceId The active tenant context, or undefined if none.
 */
export function classifyTenantAccess(params: {
  model: string | undefined
  operation: string
  args: unknown
  workspaceId: string | undefined
}): { result: TenantAccessResult; reason?: string } {
  const { model, operation, args, workspaceId } = params

  if (!workspaceId) return { result: 'skipped', reason: 'no-context' }
  if (!model || !TENANT_MODELS.has(model)) return { result: 'skipped', reason: 'non-tenant-model' }
  if (SINGLE_ROW_OPS.has(operation)) return { result: 'skipped', reason: 'single-row-unique' }
  if (!GUARDED_OPS.has(operation)) return { result: 'skipped', reason: 'unguarded-op' }

  // create / createMany are scoped by the data payload, everything else by where.
  const isCreate = operation === 'create' || operation === 'createMany'
  const argObj = (args ?? {}) as Record<string, unknown>
  const subject = isCreate ? argObj.data : argObj.where

  // createMany takes data: T[]; require EVERY row to carry the workspace directly
  // (each row is a flat object, never itself an AND/OR/NOT combinator).
  if (operation === 'createMany' && Array.isArray(subject)) {
    const allScoped = subject.length > 0 && subject.every((row) => matchesWorkspace((row as Record<string, unknown>)?.workspaceId, workspaceId))
    if (allScoped) return { result: 'scoped' }
    return { result: 'unscoped', reason: 'createMany row missing workspaceId' }
  }

  const verdict = classifySubtree(subject, workspaceId)
  if (verdict === 'scoped') return { result: 'scoped' }
  if (verdict === 'scoped_via_fk') return { result: 'scoped_via_fk' }
  return {
    result: 'unscoped',
    reason: `${operation} on ${model} has no workspaceId or tenant foreign-key filter that holds across every OR branch`,
  }
}
