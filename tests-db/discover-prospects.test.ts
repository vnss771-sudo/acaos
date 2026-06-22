// Database-backed tests for the async discover-prospects worker processor.
// The provider search is injected via the deps seam so the FAILED / PARTIAL /
// SUCCEEDED finalization paths are exercised without a live provider.

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { discoverProspectsBatch } from '../apps/worker/src/processors.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace } from './helpers/db.ts'
import type { ProspectCandidate } from '../packages/backend-core/src/lib/prospectSources.ts'

after(async () => { await disconnect() })
beforeEach(async () => { await resetDb() })

async function seedRun(workspaceId: string, source = 'apollo') {
  return prisma.discoveryRun.create({
    data: { workspaceId, source, status: 'RUNNING', query: { limit: 25, industries: [], locations: [], keywords: [] } },
    select: { id: true },
  })
}

function candidate(name: string, extra: Partial<ProspectCandidate> = {}): ProspectCandidate {
  return { companyName: name, ...extra }
}

test('SUCCEEDED: imports candidates, dedupes, and finalizes the run with counts', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const run = await seedRun(workspace.id)
  // One brand-new company and one that already exists (dedupe by name).
  await prisma.prospect.create({ data: { workspaceId: workspace.id, companyName: 'existing co' } })

  const result = await discoverProspectsBatch(run.id, workspace.id, undefined, {
    search: async () => [candidate('Fresh Widgets', { domain: 'fresh.example' }), candidate('Existing Co')],
  })

  assert.equal(result.status, 'SUCCEEDED')
  assert.equal(result.imported, 1)
  assert.equal(result.skipped, 1)
  assert.equal(result.total, 2)
  const finalized = await prisma.discoveryRun.findUnique({ where: { id: run.id } })
  assert.equal(finalized!.status, 'SUCCEEDED')
  assert.equal(finalized!.importedCount, 1)
  assert.equal(finalized!.skippedCount, 1)
  assert.ok(finalized!.finishedAt)
  // The imported prospect carries the normalized dedupe keys.
  const fresh = await prisma.prospect.findFirst({ where: { workspaceId: workspace.id, companyName: 'Fresh Widgets' } })
  assert.equal(fresh!.domainKey, 'fresh.example')
  assert.equal(fresh!.companyNameKey, 'fresh widgets')
})

test('FAILED: a provider error marks the run FAILED and imports nothing', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const run = await seedRun(workspace.id)

  const result = await discoverProspectsBatch(run.id, workspace.id, undefined, {
    search: async () => { throw new Error('provider exploded') },
  })

  assert.equal(result.status, 'FAILED')
  assert.equal(result.imported, 0)
  const finalized = await prisma.discoveryRun.findUnique({ where: { id: run.id } })
  assert.equal(finalized!.status, 'FAILED')
  assert.match(finalized!.errorMessage ?? '', /provider exploded/)
  assert.equal(await prisma.prospect.count({ where: { workspaceId: workspace.id } }), 0)
})

test('PARTIAL: a fatal mid-import error records PARTIAL with the counts so far', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const run = await seedRun(workspace.id)

  // First candidate imports cleanly; the second carries an employeeCount that
  // overflows Postgres INT4, so its insert throws mid-batch after one success →
  // the worker records PARTIAL with imported=1.
  const result = await discoverProspectsBatch(run.id, workspace.id, undefined, {
    search: async () => [
      candidate('First Co', { domain: 'first.co' }),
      candidate('Overflow Co', { domain: 'of.co', employeeCount: 9_999_999_999_999 }),
    ],
  })

  assert.equal(result.status, 'PARTIAL')
  assert.equal(result.imported, 1)
  const finalized = await prisma.discoveryRun.findUnique({ where: { id: run.id } })
  assert.equal(finalized!.status, 'PARTIAL')
  assert.equal(finalized!.importedCount, 1)
  assert.equal(finalized!.errorCode, 'IMPORT_INTERRUPTED')
  // The first prospect did land.
  assert.equal(await prisma.prospect.count({ where: { workspaceId: workspace.id } }), 1)
})

test('guard: a run not in RUNNING state is not reprocessed', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const run = await prisma.discoveryRun.create({
    data: { workspaceId: workspace.id, source: 'apollo', status: 'SUCCEEDED', query: {} },
    select: { id: true },
  })
  let searched = false
  const result = await discoverProspectsBatch(run.id, workspace.id, undefined, {
    search: async () => { searched = true; return [] },
  })
  assert.equal(result.status, 'SUCCEEDED')
  assert.equal(searched, false, 'an already-finalized run must not call the provider')
})

test('guard: a run from another workspace is rejected', async () => {
  const a = await seedUserWithWorkspace()
  const b = await seedUserWithWorkspace()
  const run = await seedRun(a.workspace.id)
  const result = await discoverProspectsBatch(run.id, b.workspace.id, undefined, {
    search: async () => [candidate('X')],
  })
  assert.equal(result.status, 'FAILED')
  // The run is untouched (still RUNNING) — a cross-tenant job is a no-op.
  const after = await prisma.discoveryRun.findUnique({ where: { id: run.id } })
  assert.equal(after!.status, 'RUNNING')
})
