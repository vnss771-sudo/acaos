// Unit tests for the worker's batch enrichment processor. Verifies per-prospect
// fault isolation (one failure can't sink the batch), example-skipping, and the
// enriched/skipped/failed tally. Fake Prisma + stubbed Apollo fetch; no Redis.

import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createFakePrisma, installPrisma, resetPrisma, type FakePrisma } from './helpers/integration.ts'
import { enrichProspectsBatch } from '../apps/worker/src/processors.ts'

const origFetch = globalThis.fetch
const origApollo = process.env.APOLLO_API_KEY
const origHunter = process.env.HUNTER_API_KEY

afterEach(() => {
  globalThis.fetch = origFetch
  resetPrisma()
  if (origApollo === undefined) delete process.env.APOLLO_API_KEY; else process.env.APOLLO_API_KEY = origApollo
  if (origHunter === undefined) delete process.env.HUNTER_API_KEY; else process.env.HUNTER_API_KEY = origHunter
})

// Apollo enrich returns an empty org (no signals) so a "good" prospect enriches
// cleanly without needing signal/Hunter fixtures.
function stubApollo() {
  globalThis.fetch = (async () => ({ ok: true, json: async () => ({ organization: null }) })) as unknown as typeof fetch
}

function goodRow(id: string) {
  return {
    id, workspaceId: 'ws1', companyName: `Co-${id}`, domain: `${id}.test`,
    industry: null, employeeCount: null, contactEmail: 'has@email.test',
    contactName: null, contactTitle: null, location: 'NYC',
    opportunityScore: 0, isExample: false,
  }
}

function batchSpec(targets: Array<{ id: string; isExample: boolean }>) {
  return {
    prospect: {
      // Initial batch target load (select id, isExample, scoped to workspace).
      findMany: async () => targets,
      // Per-prospect load inside enrichProspectCore. 'bad' throws to exercise
      // fault isolation; others return a complete, already-emailed row.
      findUnique: async (a: any) => {
        const id = a?.where?.id
        if (id === 'bad') throw new Error('boom')
        return goodRow(id)
      },
      update: async (a: any) => ({ id: a?.where?.id }),
    },
    signal: { findMany: async () => [] },
    workspaceICP: { findUnique: async () => null },
    auditEvent: { create: async () => ({ id: 'a1' }) },
  }
}

test('isolates a failing prospect — the rest of the batch still enriches', async () => {
  process.env.APOLLO_API_KEY = 'a'
  delete process.env.HUNTER_API_KEY
  stubApollo()
  installPrisma(createFakePrisma(batchSpec([
    { id: 'good1', isExample: false },
    { id: 'bad',   isExample: false },
    { id: 'good2', isExample: false },
  ])) as FakePrisma)

  const res = await enrichProspectsBatch('ws1', ['good1', 'bad', 'good2'])
  assert.equal(res.enriched, 2)
  assert.equal(res.failed, 1)
  assert.equal(res.skipped, 0)
})

test('skips example prospects and never calls the core for them', async () => {
  process.env.APOLLO_API_KEY = 'a'
  delete process.env.HUNTER_API_KEY
  stubApollo()
  const prisma = createFakePrisma(batchSpec([
    { id: 'good1', isExample: false },
    { id: 'ex',    isExample: true },
  ])) as FakePrisma
  installPrisma(prisma)

  const res = await enrichProspectsBatch('ws1', ['good1', 'ex'])
  assert.equal(res.enriched, 1)
  assert.equal(res.skipped, 1)
  assert.equal(res.failed, 0)
  // The example row is filtered before the core runs, so findUnique is only hit
  // for the single real prospect.
  assert.equal(prisma.callsTo('prospect', 'findUnique').length, 1)
})

test('reports an all-example batch as fully skipped', async () => {
  process.env.APOLLO_API_KEY = 'a'
  stubApollo()
  installPrisma(createFakePrisma(batchSpec([
    { id: 'e1', isExample: true },
    { id: 'e2', isExample: true },
  ])) as FakePrisma)

  const res = await enrichProspectsBatch('ws1', ['e1', 'e2'])
  assert.deepEqual(res, { workspaceId: 'ws1', enriched: 0, skipped: 2, failed: 0 })
})
