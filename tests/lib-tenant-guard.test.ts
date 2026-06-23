// Unit tests for the tenant-isolation guard: the pure access classifier, the mode
// resolver, and the AsyncLocalStorage context. The guard is a defense-in-depth
// backstop against cross-tenant Prisma access; these pin the classification rules
// that decide what counts as "scoped" vs a catastrophic "unscoped" query.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  classifyTenantAccess, tenantGuardMode, TENANT_MODELS, TENANT_FOREIGN_KEYS,
} from '../packages/backend-core/src/lib/tenantGuard.ts'
import {
  runInWorkspaceContext, currentWorkspaceId,
} from '../packages/backend-core/src/lib/tenantContext.ts'

const WS = 'ws-123'
const classify = (model: string | undefined, operation: string, args: unknown, workspaceId: string | undefined = WS) =>
  classifyTenantAccess({ model, operation, args, workspaceId }).result

// ── skipped: out of scope ───────────────────────────────────────────────────────

test('no active tenant context → skipped (the guard is inert outside a context)', () => {
  // Called directly (not via the `classify` helper, whose default param would mask
  // an explicit undefined workspaceId).
  assert.equal(
    classifyTenantAccess({ model: 'Lead', operation: 'findMany', args: { where: {} }, workspaceId: undefined }).result,
    'skipped',
  )
})

test('non-tenant model → skipped', () => {
  assert.equal(classify('User', 'findMany', { where: {} }), 'skipped')
  assert.equal(classify('Workspace', 'findMany', { where: {} }), 'skipped')
  assert.equal(classify(undefined, 'findMany', { where: {} }), 'skipped') // raw/top-level op
})

test('single-row ops keyed by a unique id → skipped (fetch-then-authorize is the control)', () => {
  for (const op of ['findUnique', 'findUniqueOrThrow', 'update', 'delete', 'upsert']) {
    assert.equal(classify('Lead', op, { where: { id: 'lead-1' } }), 'skipped', op)
  }
})

// ── scoped: explicit workspaceId ────────────────────────────────────────────────

test('multi-row read with where.workspaceId === context → scoped', () => {
  assert.equal(classify('Lead', 'findMany', { where: { workspaceId: WS } }), 'scoped')
  assert.equal(classify('Lead', 'findMany', { where: { workspaceId: { equals: WS } } }), 'scoped')
})

test('workspaceId nested inside AND/OR combinators → scoped', () => {
  assert.equal(classify('Lead', 'findMany', { where: { AND: [{ stage: 'NEW' }, { workspaceId: WS }] } }), 'scoped')
  assert.equal(classify('Signal', 'count', { where: { OR: [{ workspaceId: { equals: WS } }] } }), 'scoped')
})

test('updateMany / deleteMany / count / groupBy honour the workspaceId filter', () => {
  assert.equal(classify('Lead', 'updateMany', { where: { workspaceId: WS }, data: { stage: 'X' } }), 'scoped')
  assert.equal(classify('Lead', 'deleteMany', { where: { workspaceId: WS } }), 'scoped')
  assert.equal(classify('UsageRecord', 'count', { where: { workspaceId: WS } }), 'scoped')
  assert.equal(classify('OutreachSent', 'groupBy', { where: { workspaceId: WS }, by: ['status'] }), 'scoped')
})

test('create / createMany scoped by data.workspaceId', () => {
  assert.equal(classify('Lead', 'create', { data: { workspaceId: WS, email: 'a@b.test' } }), 'scoped')
  assert.equal(classify('Lead', 'createMany', { data: [{ workspaceId: WS }, { workspaceId: WS }] }), 'scoped')
})

// ── scoped_via_fk: tenant-owned foreign key ─────────────────────────────────────

test('a tenant foreign key (campaignId, leadId, …) scopes transitively → scoped_via_fk', () => {
  assert.equal(classify('OutreachSent', 'findMany', { where: { campaignId: 'c1', leadId: { in: ['l1'] } } }), 'scoped_via_fk')
  assert.equal(classify('Signal', 'findMany', { where: { prospectId: 'p1' } }), 'scoped_via_fk')
})

// ── unscoped: the catastrophic case ─────────────────────────────────────────────

test('multi-row query with no workspaceId and no tenant FK → unscoped', () => {
  assert.equal(classify('Lead', 'findMany', { where: {} }), 'unscoped')
  assert.equal(classify('Lead', 'findMany', {}), 'unscoped')
  assert.equal(classify('Lead', 'findMany', { where: { stage: 'NEW' } }), 'unscoped')
  assert.equal(classify('Lead', 'deleteMany', { where: { email: 'a@b.test' } }), 'unscoped')
})

test('a query pinned to a DIFFERENT workspace is not treated as scoped (flagged)', () => {
  assert.equal(classify('Lead', 'findMany', { where: { workspaceId: 'other-ws' } }), 'unscoped')
})

test('createMany where any row is missing workspaceId → unscoped', () => {
  assert.equal(classify('Lead', 'createMany', { data: [{ workspaceId: WS }, { email: 'x@y.test' }] }), 'unscoped')
  assert.equal(classify('Lead', 'createMany', { data: [] }), 'unscoped')
})

// ── registries ──────────────────────────────────────────────────────────────────

test('the tenant-model and FK registries are populated and sane', () => {
  assert.ok(TENANT_MODELS.has('Lead') && TENANT_MODELS.has('OutreachSent') && TENANT_MODELS.has('Campaign'))
  assert.ok(!TENANT_MODELS.has('User') && !TENANT_MODELS.has('Workspace'))
  assert.ok(TENANT_FOREIGN_KEYS.includes('campaignId') && TENANT_FOREIGN_KEYS.includes('leadId'))
})

test('TENANT_MODELS stays in sync with the schema (every model with a workspaceId field)', () => {
  const schemaPath = fileURLToPath(new URL('../packages/db/prisma/schema.prisma', import.meta.url))
  const schema = readFileSync(schemaPath, 'utf8')
  const fromSchema = new Set<string>()
  let current: string | null = null
  for (const line of schema.split('\n')) {
    const model = line.match(/^model\s+([A-Za-z0-9_]+)\s*\{/)
    if (model) { current = model[1]; continue }
    if (line.trim() === '}') { current = null; continue }
    if (current && /^\s*workspaceId\s+String/.test(line)) fromSchema.add(current)
  }
  const guarded = new Set(TENANT_MODELS)
  const missing = [...fromSchema].filter((m) => !guarded.has(m))
  const extra = [...guarded].filter((m) => !fromSchema.has(m))
  assert.deepEqual(missing, [], `tenant models in schema but missing from TENANT_MODELS: ${missing.join(', ')}`)
  assert.deepEqual(extra, [], `models in TENANT_MODELS not in schema: ${extra.join(', ')}`)
})

// ── mode resolver ─────────────────────────────────────────────────────────────

test('tenantGuardMode defaults to off and parses observe/enforce case-insensitively', () => {
  const saved = process.env.TENANT_GUARD_MODE
  try {
    delete process.env.TENANT_GUARD_MODE
    assert.equal(tenantGuardMode(), 'off')
    process.env.TENANT_GUARD_MODE = 'observe'
    assert.equal(tenantGuardMode(), 'observe')
    process.env.TENANT_GUARD_MODE = 'ENFORCE'
    assert.equal(tenantGuardMode(), 'enforce')
    process.env.TENANT_GUARD_MODE = 'nonsense'
    assert.equal(tenantGuardMode(), 'off', 'unknown values fall back to off')
  } finally {
    if (saved === undefined) delete process.env.TENANT_GUARD_MODE
    else process.env.TENANT_GUARD_MODE = saved
  }
})

// ── AsyncLocalStorage context ─────────────────────────────────────────────────

test('runInWorkspaceContext sets the active workspace and restores on exit', async () => {
  assert.equal(currentWorkspaceId(), undefined)
  const inside = runInWorkspaceContext('ws-A', () => currentWorkspaceId())
  assert.equal(inside, 'ws-A')
  assert.equal(currentWorkspaceId(), undefined, 'context does not leak past the callback')
})

test('context propagates across awaits and nests', async () => {
  const seen = await runInWorkspaceContext('ws-outer', async () => {
    const before = currentWorkspaceId()
    await Promise.resolve()
    const afterAwait = currentWorkspaceId()
    const nested = runInWorkspaceContext('ws-inner', () => currentWorkspaceId())
    const afterNested = currentWorkspaceId()
    return { before, afterAwait, nested, afterNested }
  })
  assert.deepEqual(seen, { before: 'ws-outer', afterAwait: 'ws-outer', nested: 'ws-inner', afterNested: 'ws-outer' })
})
