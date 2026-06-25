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
  'AiPromptVersion', 'AuditEvent', 'Campaign', 'CampaignDailyStats', 'ConsentRecord',
  'ContactEvent',
  'DiscoveryRun', 'EvidenceSource', 'FollowupTask', 'Lead', 'LeadEvidenceSource',
  'Membership', 'Mission',
  'OutreachDraft', 'OutreachIntent', 'OutreachSent', 'ProcessedEmail', 'Prospect',
  'ProspectOutcome', 'Recommendation', 'ScoringModel', 'ScoringOutcome', 'Signal',
  'Suppression', 'UnsubscribeEvent', 'UsageRecord', 'WorkspaceDraftPolicy',
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

/** Shallow-recursive search for a key anywhere in a Prisma where/data object,
 *  descending only through AND/OR/NOT combinators and plain nested objects. Bounded
 *  depth so a pathological payload can't blow the stack. Returns the matched value. */
function findKey(obj: unknown, key: string, depth = 0): unknown {
  if (depth > 6 || obj === null || typeof obj !== 'object') return undefined
  if (Array.isArray(obj)) {
    for (const el of obj) {
      const hit = findKey(el, key, depth + 1)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  const rec = obj as Record<string, unknown>
  if (key in rec && rec[key] !== undefined) return rec[key]
  for (const combinator of ['AND', 'OR', 'NOT'] as const) {
    if (combinator in rec) {
      const hit = findKey(rec[combinator], key, depth + 1)
      if (hit !== undefined) return hit
    }
  }
  return undefined
}

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

  // createMany takes data: T[]; require EVERY row to carry the workspace.
  if (operation === 'createMany' && Array.isArray(subject)) {
    const allScoped = subject.length > 0 && subject.every((row) => matchesWorkspace(findKey(row, 'workspaceId'), workspaceId))
    if (allScoped) return { result: 'scoped' }
    return { result: 'unscoped', reason: 'createMany row missing workspaceId' }
  }

  if (matchesWorkspace(findKey(subject, 'workspaceId'), workspaceId)) {
    return { result: 'scoped' }
  }
  for (const fk of TENANT_FOREIGN_KEYS) {
    if (findKey(subject, fk) !== undefined) return { result: 'scoped_via_fk', reason: fk }
  }
  return { result: 'unscoped', reason: `${operation} on ${model} has no workspaceId or tenant foreign-key filter` }
}
