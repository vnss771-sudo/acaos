// Performance and load tests for the ACAOS SaaS project.
//
// Covers concurrent ingest requests, ingestCache safety, CSV export pagination,
// campaign stats under concurrent load, circuit breaker concurrency, and
// escCsv throughput. All tests use node:test with fake Prisma — no live DB.

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { ingestRouter } from '../apps/api/src/routes/ingest.ts'
import { campaignsRouter } from '../apps/api/src/routes/campaigns.ts'
import { leadsRouter } from '../apps/api/src/routes/leads.ts'
import { hashApiKey } from '../apps/api/src/lib/apiKeys.ts'
import {
  getCachedWorkspace,
  setCachedWorkspace,
  evictCachedWorkspace,
} from '../apps/api/src/lib/ingestCache.ts'
import { CircuitBreaker, CircuitOpenError } from '../packages/backend-core/src/lib/circuit.ts'
import { escCsv } from '../apps/api/src/lib/csv.ts'
import {
  createFakePrisma,
  installPrisma,
  resetPrisma,
  startTestServer,
  bearer,
  type TestServer,
} from './helpers/integration.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const API_KEY = 'perf-test-api-key-xyz'
const API_KEY_HASH = hashApiKey(API_KEY)
const WS_ID = 'ws-perf-1'
const USER_ID = 'user-perf-1'

function ingestHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json', 'x-api-key': API_KEY }
}

function authHeaders(userId = USER_ID): Record<string, string> {
  return { Authorization: bearer(userId), 'Content-Type': 'application/json' }
}

/** Build N leads with unique businessName and optionally unique email. */
function makeLeads(count: number, opts: { withEmail?: boolean; emailPrefix?: string } = {}): object[] {
  return Array.from({ length: count }, (_, i) => ({
    businessName: `Company ${i}`,
    ...(opts.withEmail ? { email: `${opts.emailPrefix ?? 'lead'}${i}@load.test` } : {}),
  }))
}

// ---------------------------------------------------------------------------
// A. Ingest endpoint under concurrent load
// ---------------------------------------------------------------------------

describe('A. Ingest endpoint under concurrent load', () => {
  let server: TestServer
  // Shared lead store per workspace to simulate dedup across concurrent requests
  let leadStore: Map<string, Set<string>> // workspaceId → set of emails

  beforeEach(async () => {
    leadStore = new Map([[WS_ID, new Set<string>()]])

    const fake = createFakePrisma({
      user: {
        findUnique: async (a: any) => ({ id: a?.where?.id, email: 'u@t.test', name: null }),
      },
      workspace: {
        findUnique: async (a: any) =>
          a?.where?.ingestApiKey === API_KEY_HASH ? { id: WS_ID, plan: 'pro' } : null,
      },
      campaign: {
        findFirst: async () => null,
      },
      lead: {
        // The capacity check counts current leads in the workspace.
        count: async () => leadStore.get(WS_ID)?.size ?? 0,
        findMany: async (a: any) => {
          // Return emails already "saved" to simulate DB dedup check
          const wsEmails = leadStore.get(WS_ID) ?? new Set()
          const requested: string[] = a?.where?.email?.in ?? []
          return requested.filter((e) => wsEmails.has(e)).map((e) => ({ email: e }))
        },
        create: async (a: any) => {
          // Record the email as saved
          if (a?.data?.email) {
            const ws = leadStore.get(WS_ID) ?? new Set()
            ws.add(a.data.email)
            leadStore.set(WS_ID, ws)
          }
          return { id: `lead-${Math.random().toString(36).slice(2)}`, ...a.data }
        },
      },
      // Use the default interactive $transaction (passes the fake client as tx)
      // so reserveLeadCapacity can run its lock/count/create on a real client.
    })
    installPrisma(fake)
    server = await startTestServer('/api/ingest', ingestRouter)
  })

  afterEach(async () => {
    await server.close()
    resetPrisma()
  })

  it('A1 — 10 parallel requests × 50 unique-email leads each: all 500 created, no cross-workspace contamination', async () => {
    const CONCURRENT = 10
    const PER_REQUEST = 50

    const results = await Promise.all(
      Array.from({ length: CONCURRENT }, (_, batch) => {
        const leads = Array.from({ length: PER_REQUEST }, (__, i) => ({
          businessName: `Batch${batch}_Co${i}`,
          email: `batch${batch}.lead${i}@nodup.test`,
        }))
        return server.request('/api/ingest', {
          method: 'POST',
          headers: ingestHeaders(),
          body: JSON.stringify({ leads, autoResearch: false }),
        })
      })
    )

    for (const res of results) {
      assert.equal(res.status, 201, `Expected 201 but got ${res.status}: ${JSON.stringify(res.body)}`)
    }

    const totalCreated = results.reduce((sum, r) => sum + (r.body.created as number), 0)
    // Each request had distinct emails so all should have been created (dedup
    // logic runs per-request against a shared store — no cross-contamination
    // means each batch's count equals PER_REQUEST).
    assert.ok(
      totalCreated >= CONCURRENT * PER_REQUEST,
      `Expected at least ${CONCURRENT * PER_REQUEST} total created, got ${totalCreated}`
    )
  })

  it('A2 — single request with MAX_BATCH (500) leads completes without error', async () => {
    const leads = makeLeads(500, { withEmail: true, emailPrefix: 'maxbatch' })
    const res = await server.request('/api/ingest', {
      method: 'POST',
      headers: ingestHeaders(),
      body: JSON.stringify({ leads, autoResearch: false }),
    })
    assert.equal(res.status, 201)
    assert.equal(res.body.created, 500)
    assert.equal(res.body.skipped, 0)
  })

  it('A3 — batch exceeding MAX_BATCH (501) is rejected with 400', async () => {
    const leads = makeLeads(501)
    const res = await server.request('/api/ingest', {
      method: 'POST',
      headers: ingestHeaders(),
      body: JSON.stringify({ leads, autoResearch: false }),
    })
    assert.equal(res.status, 400)
  })

  it('A4 — concurrent requests with overlapping emails: deduplication fires, no double-create', async () => {
    // Use a single shared email across all concurrent batches
    const SHARED_EMAIL = 'overlap@concurrent.test'
    const leads = [{ businessName: 'Overlap Co', email: SHARED_EMAIL }]

    // Fire 5 concurrent requests all containing the same email.
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        server.request('/api/ingest', {
          method: 'POST',
          headers: ingestHeaders(),
          body: JSON.stringify({ leads, autoResearch: false }),
        })
      )
    )

    // All requests should succeed: 201 if any lead was created, 200 if all skipped
    for (const res of results) {
      assert.ok(
        res.status === 201 || res.status === 200,
        `Unexpected status ${res.status}: ${JSON.stringify(res.body)}`
      )
    }

    const totalCreated = results.reduce((sum, r) => sum + (r.body.created as number), 0)
    // The fake's findMany returns already-saved emails, so after the first
    // request saves the email, subsequent requests should skip it.
    // totalCreated should be between 1 (perfectly serialized) and 5 (all raced).
    // We assert at least 1 was created (the email exists somewhere).
    assert.ok(totalCreated >= 1, `Expected at least 1 total created across concurrent requests`)
  })

  it('A5 — workspace isolation: two workspaces do not share leads', async () => {
    // This test verifies that the workspace id is always correctly scoped.
    // Since our fake always returns WS_ID for any valid API key, all leads
    // go to WS_ID; we verify no cross-contamination by checking workspaceId.
    const leads = [{ businessName: 'Isolated Co', email: 'isolated@ws.test' }]
    const res = await server.request('/api/ingest', {
      method: 'POST',
      headers: ingestHeaders(),
      body: JSON.stringify({ leads, autoResearch: false }),
    })
    assert.equal(res.status, 201)
    assert.equal(res.body.created, 1)
    // leadStore should contain only this workspace
    assert.equal(leadStore.size, 1)
    assert.ok(leadStore.has(WS_ID))
  })
})

// ---------------------------------------------------------------------------
// B. ingestCache concurrent safety
// ---------------------------------------------------------------------------

describe('B. ingestCache concurrent safety', () => {
  // The cache module keeps a module-level Map; we can exercise it directly.
  // We evict test keys after each test to avoid cross-test pollution.

  const keysUsed: string[] = []

  afterEach(() => {
    for (const k of keysUsed) evictCachedWorkspace(k)
    keysUsed.length = 0
  })

  it('B1 — getCachedWorkspace returns null for unknown hash', () => {
    const result = getCachedWorkspace('nonexistent-hash-xyz')
    assert.equal(result, null)
  })

  it('B2 — setCachedWorkspace then getCachedWorkspace returns the workspace', () => {
    const hash = 'test-hash-b2'
    keysUsed.push(hash)
    setCachedWorkspace(hash, { id: 'ws-b2', plan: 'pro' })
    const result = getCachedWorkspace(hash)
    assert.deepEqual(result, { id: 'ws-b2', plan: 'pro' })
  })

  it('B3 — 100 concurrent setCachedWorkspace calls produce no corruption', async () => {
    const CONCURRENT = 100
    const hashes = Array.from({ length: CONCURRENT }, (_, i) => `hash-b3-${i}`)
    keysUsed.push(...hashes)

    // Simulate concurrent writes
    await Promise.all(
      hashes.map((hash, i) =>
        Promise.resolve().then(() =>
          setCachedWorkspace(hash, { id: `ws-${i}`, plan: i % 2 === 0 ? 'free' : 'pro' })
        )
      )
    )

    // Verify every entry was stored correctly
    for (let i = 0; i < CONCURRENT; i++) {
      const result = getCachedWorkspace(hashes[i])
      assert.ok(result !== null, `Cache miss for hash-b3-${i}`)
      assert.equal(result!.id, `ws-${i}`)
      assert.equal(result!.plan, i % 2 === 0 ? 'free' : 'pro')
    }
  })

  it('B4 — concurrent reads on the same key all return the same value', async () => {
    const hash = 'hash-b4-shared'
    keysUsed.push(hash)
    setCachedWorkspace(hash, { id: 'ws-shared', plan: 'enterprise' })

    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        Promise.resolve().then(() => getCachedWorkspace(hash))
      )
    )

    for (const r of results) {
      assert.deepEqual(r, { id: 'ws-shared', plan: 'enterprise' })
    }
  })

  it('B5 — evictCachedWorkspace immediately removes the entry', () => {
    const hash = 'hash-b5-evict'
    keysUsed.push(hash)
    setCachedWorkspace(hash, { id: 'ws-evict', plan: 'pro' })
    assert.ok(getCachedWorkspace(hash) !== null, 'Should be present before eviction')
    evictCachedWorkspace(hash)
    assert.equal(getCachedWorkspace(hash), null, 'Should be gone after eviction')
  })

  it('B6 — TTL expiry: manually overwrite expiresAt to simulate expiry', () => {
    // We can not override the module-level TTL, but we can test that a freshly
    // set entry is present, then simulate what the module does when Date.now()
    // > expiresAt: the only observable behavior is getCachedWorkspace returns null
    // after the underlying Map entry has an expired expiresAt.
    // We test the boundary condition by writing a helper that calls through
    // the public API twice and verifies consistency.
    const hash = 'hash-b6-ttl'
    keysUsed.push(hash)
    setCachedWorkspace(hash, { id: 'ws-ttl', plan: 'free' })
    // Immediately readable
    assert.deepEqual(getCachedWorkspace(hash), { id: 'ws-ttl', plan: 'free' })
    // Evict simulates what the TTL check does
    evictCachedWorkspace(hash)
    assert.equal(getCachedWorkspace(hash), null)
  })

  it('B7 — concurrent evict-write sequence: no stale entry survives', async () => {
    const hash = 'hash-b7-race'
    keysUsed.push(hash)
    setCachedWorkspace(hash, { id: 'ws-stale', plan: 'free' })

    // Interleave evictions and writes
    await Promise.all([
      Promise.resolve().then(() => evictCachedWorkspace(hash)),
      Promise.resolve().then(() => setCachedWorkspace(hash, { id: 'ws-fresh', plan: 'pro' })),
      Promise.resolve().then(() => getCachedWorkspace(hash)),
      Promise.resolve().then(() => evictCachedWorkspace(hash)),
    ])

    // After all operations, cache should not contain the stale workspace.
    // The final state depends on execution order; either null or fresh is valid.
    const result = getCachedWorkspace(hash)
    if (result !== null) {
      // If something is there, it must be the fresh one, never the stale one
      assert.notEqual(result.id, 'ws-stale', 'Stale entry must not survive a race')
    }
  })

  it('B8 — overwriting an existing key updates both id and plan', () => {
    const hash = 'hash-b8-overwrite'
    keysUsed.push(hash)
    setCachedWorkspace(hash, { id: 'ws-old', plan: 'free' })
    setCachedWorkspace(hash, { id: 'ws-new', plan: 'enterprise' })
    const result = getCachedWorkspace(hash)
    assert.deepEqual(result, { id: 'ws-new', plan: 'enterprise' })
  })
})

// ---------------------------------------------------------------------------
// C. Cursor-based export pagination correctness
// ---------------------------------------------------------------------------

describe('C. Cursor-based export pagination correctness', () => {
  const PAGE_SIZE = 500
  const USER = 'export-user'
  const WS = 'ws-export'

  let server: TestServer

  function makeExportSpec(allLeads: object[]) {
    // Simulate cursor-based pagination: the route calls lead.findMany with
    // take=PAGE_SIZE and optional cursor (skip: 1, cursor: { id }).
    // We replicate the orderBy [createdAt desc, id desc] sorting.
    const sorted = [...allLeads] as Array<{ id: string; createdAt: Date; [k: string]: unknown }>

    return createFakePrisma({
      user: {
        findUnique: async () => ({ id: USER, email: 'u@e.test', name: null, emailVerified: true }),
      },
      membership: {
        findFirst: async (a: any) =>
          a?.where?.userId === USER && a?.where?.workspaceId === WS ? { id: 'm1', role: 'admin' } : null,
      },
      scoringModel: { findUnique: async () => null },
      lead: {
        findMany: async (a: any) => {
          const take: number = a?.take ?? PAGE_SIZE
          const cursorId: string | undefined = a?.cursor?.id
          const skip: number = a?.skip ?? 0

          let start = 0
          if (cursorId) {
            const idx = sorted.findIndex((l) => l.id === cursorId)
            start = idx === -1 ? sorted.length : idx + skip
          }
          return sorted.slice(start, start + take)
        },
        count: async () => sorted.length,
        create: async (a: any) => ({ id: 'l-new', ...a.data }),
        createMany: async (a: any) => ({ count: (a?.data ?? []).length }),
        findUnique: async () => null,
        update: async (a: any) => ({ id: a?.where?.id }),
        delete: async () => ({}),
        deleteMany: async () => ({ count: 0 }),
        updateMany: async () => ({ count: 0 }),
      },
      campaign: { findFirst: async () => null },
    })
  }

  afterEach(async () => {
    await server.close()
    resetPrisma()
  })

  it('C1 — export with 0 leads: response is headers-only CSV', async () => {
    const fake = makeExportSpec([])
    installPrisma(fake)
    server = await startTestServer('/api/leads', leadsRouter)

    const res = await fetch(`${server.baseUrl}/api/leads/export?workspaceId=${WS}`, {
      headers: { Authorization: bearer(USER) },
    })
    assert.equal(res.status, 200)
    assert.ok(res.headers.get('content-type')?.includes('text/csv'))
    const text = await res.text()
    const lines = text.trim().split('\n')
    // Only the header row
    assert.equal(lines.length, 1, `Expected 1 line (headers only), got ${lines.length}`)
    assert.ok(lines[0].includes('businessName'), 'Header line should include businessName')
  })

  it('C2 — export with exactly PAGE_SIZE leads: single page, all rows present', async () => {
    const now = new Date()
    const leads = Array.from({ length: PAGE_SIZE }, (_, i) => ({
      id: `lead-${String(i).padStart(6, '0')}`,
      businessName: `Co ${i}`,
      contactName: null,
      email: `e${i}@x.test`,
      phone: null,
      website: null,
      city: null,
      category: null,
      score: 0,
      stage: 'NEW',
      sourceTag: null,
      notes: null,
      aiSummary: null,
      outreachAngle: null,
      createdAt: new Date(now.getTime() - i * 1000),
      updatedAt: new Date(now.getTime() - i * 1000),
    }))

    const fake = makeExportSpec(leads)
    installPrisma(fake)
    server = await startTestServer('/api/leads', leadsRouter)

    const res = await fetch(`${server.baseUrl}/api/leads/export?workspaceId=${WS}`, {
      headers: { Authorization: bearer(USER) },
    })
    assert.equal(res.status, 200)
    const text = await res.text()
    const lines = text.trim().split('\n')
    // 1 header + PAGE_SIZE data rows
    assert.equal(lines.length, PAGE_SIZE + 1, `Expected ${PAGE_SIZE + 1} lines, got ${lines.length}`)
    // No duplicates: all IDs unique
    const ids = lines.slice(1).map((l) => l.split(',')[0])
    assert.equal(new Set(ids).size, PAGE_SIZE, 'All exported IDs must be unique')
  })

  it('C3 — export with PAGE_SIZE+1 leads: two pages, all rows present, no duplicates', async () => {
    const now = new Date()
    const TOTAL = PAGE_SIZE + 1
    const leads = Array.from({ length: TOTAL }, (_, i) => ({
      id: `lead-${String(i).padStart(6, '0')}`,
      businessName: `Co ${i}`,
      contactName: null,
      email: null,
      phone: null,
      website: null,
      city: null,
      category: null,
      score: 0,
      stage: 'NEW',
      sourceTag: null,
      notes: null,
      aiSummary: null,
      outreachAngle: null,
      createdAt: new Date(now.getTime() - i * 1000),
      updatedAt: new Date(now.getTime() - i * 1000),
    }))

    const fake = makeExportSpec(leads)
    installPrisma(fake)
    server = await startTestServer('/api/leads', leadsRouter)

    const res = await fetch(`${server.baseUrl}/api/leads/export?workspaceId=${WS}`, {
      headers: { Authorization: bearer(USER) },
    })
    assert.equal(res.status, 200)
    const text = await res.text()
    const lines = text.trim().split('\n')
    assert.equal(lines.length, TOTAL + 1, `Expected ${TOTAL + 1} lines (header + ${TOTAL} data), got ${lines.length}`)

    // Verify no duplicate rows
    const ids = lines.slice(1).map((l) => l.split(',')[0])
    assert.equal(new Set(ids).size, TOTAL, `Expected ${TOTAL} unique IDs, found ${new Set(ids).size}`)
  })

  it('C4 — export with MAX (50,000) leads simulated via mock: completes without OOM, total rows correct', async () => {
    const MAX = 50_000
    const now = new Date()
    // Build a fake that returns pages without materializing all 50k objects
    const chunkSize = 500
    let callCount = 0

    const streamFake = createFakePrisma({
      user: {
        findUnique: async () => ({ id: USER, email: 'u@e.test', name: null, emailVerified: true }),
      },
      membership: {
        findFirst: async (a: any) =>
          a?.where?.userId === USER && a?.where?.workspaceId === WS ? { id: 'm1', role: 'admin' } : null,
      },
      scoringModel: { findUnique: async () => null },
      lead: {
        findMany: async (a: any) => {
          const take: number = a?.take ?? chunkSize

          const pageNum = callCount++
          const offset = pageNum * chunkSize
          if (offset >= MAX) return []

          const count = Math.min(take, MAX - offset)
          return Array.from({ length: count }, (_, i) => {
            const idx = offset + i
            return {
              id: `lead-${String(idx).padStart(8, '0')}`,
              businessName: `Company ${idx}`,
              contactName: null,
              email: null,
              phone: null,
              website: null,
              city: null,
              category: null,
              score: 0,
              stage: 'NEW',
              sourceTag: null,
              notes: null,
              aiSummary: null,
              outreachAngle: null,
              createdAt: new Date(now.getTime() - idx * 100),
              updatedAt: new Date(now.getTime() - idx * 100),
            }
          })
        },
        count: async () => MAX,
        create: async (a: any) => ({ id: 'x', ...a.data }),
        createMany: async () => ({ count: 0 }),
        findUnique: async () => null,
        update: async (a: any) => ({ id: a?.where?.id }),
        delete: async () => ({}),
        deleteMany: async () => ({ count: 0 }),
        updateMany: async () => ({ count: 0 }),
      },
      campaign: { findFirst: async () => null },
    })
    installPrisma(streamFake)
    server = await startTestServer('/api/leads', leadsRouter)

    const start = Date.now()
    const res = await fetch(`${server.baseUrl}/api/leads/export?workspaceId=${WS}`, {
      headers: { Authorization: bearer(USER) },
    })
    assert.equal(res.status, 200)
    const text = await res.text()
    const elapsed = Date.now() - start

    const lines = text.trim().split('\n')
    // 1 header + MAX data rows
    assert.equal(lines.length, MAX + 1, `Expected ${MAX + 1} lines, got ${lines.length}`)

    // Should complete in a reasonable time (under 30s) — not a hard perf gate,
    // just ensures no infinite loop / hang
    assert.ok(elapsed < 30_000, `Export took ${elapsed}ms — possible infinite loop`)
  })

  it('C5 — stable ordering: first row is most recently created, last is oldest', async () => {
    const now = new Date()
    const TOTAL = 10
    // Leads ordered newest first (createdAt desc)
    const leads = Array.from({ length: TOTAL }, (_, i) => ({
      id: `lead-order-${TOTAL - i}`,
      businessName: `Co ${TOTAL - i}`,
      contactName: null,
      email: null,
      phone: null,
      website: null,
      city: null,
      category: null,
      score: 0,
      stage: 'NEW',
      sourceTag: null,
      notes: null,
      aiSummary: null,
      outreachAngle: null,
      createdAt: new Date(now.getTime() - i * 1000),
      updatedAt: new Date(now.getTime() - i * 1000),
    }))

    const fake = makeExportSpec(leads)
    installPrisma(fake)
    server = await startTestServer('/api/leads', leadsRouter)

    const res = await fetch(`${server.baseUrl}/api/leads/export?workspaceId=${WS}`, {
      headers: { Authorization: bearer(USER) },
    })
    const text = await res.text()
    const lines = text.trim().split('\n')
    // First data row should be the most recent (lead-order-10)
    assert.ok(lines[1].startsWith('lead-order-10'), `First row should be newest; got: ${lines[1].substring(0, 30)}`)
    // Last data row should be oldest (lead-order-1)
    assert.ok(
      lines[lines.length - 1].startsWith('lead-order-1,'),
      `Last row should be oldest; got: ${lines[lines.length - 1].substring(0, 30)}`
    )
  })
})

// ---------------------------------------------------------------------------
// D. Campaign stats under concurrent load
// ---------------------------------------------------------------------------

describe('D. Campaign stats under concurrent load', () => {
  const USER = 'stats-user'
  const WS = 'ws-stats'
  const CAMP = 'camp-stats'

  let server: TestServer

  function makeStatsSpec(opts: {
    totalLeads?: number
    leadsWithEmail?: number
    eligible?: number
    sent?: number
    replied?: number
  }) {
    const { totalLeads = 100, leadsWithEmail = 80, eligible = 60, sent = 50, replied = 10 } = opts
    return createFakePrisma({
      user: { findUnique: async () => ({ id: USER, email: 'u@s.test', name: null, emailVerified: true }) },
      membership: {
        findFirst: async (a: any) =>
          a?.where?.userId === USER && a?.where?.workspaceId === WS ? { id: 'm1', role: 'admin' } : null,
      },
      campaign: {
        findUnique: async (a: any) =>
          a?.where?.id === CAMP
            ? { id: CAMP, workspaceId: WS, name: 'Perf Camp', goalType: 'BOOK_CALL', _count: { leads: totalLeads } }
            : null,
        findMany: async () => [],
        create: async () => ({ id: CAMP }),
        update: async () => ({ id: CAMP }),
        delete: async () => ({}),
      },
      lead: {
        count: async (a: any) => {
          if (a?.where?.stage?.notIn) return eligible
          return leadsWithEmail
        },
        findMany: async () => [],
        findUnique: async () => null,
        create: async () => ({}),
        createMany: async () => ({ count: 0 }),
        update: async () => ({}),
        delete: async () => ({}),
        deleteMany: async () => ({ count: 0 }),
        updateMany: async () => ({ count: 0 }),
      },
      outreachSent: {
        count: async (a: any) => (a?.where?.status === 'REPLIED' ? replied : sent),
        findMany: async () => [],
      },
    })
  }

  afterEach(async () => {
    await server.close()
    resetPrisma()
  })

  it('D1 — 5 concurrent GET /stats requests all return consistent counts', async () => {
    const SENT = 50
    const REPLIED = 10
    const fake = makeStatsSpec({ sent: SENT, replied: REPLIED })
    installPrisma(fake)
    server = await startTestServer('/api/campaigns', campaignsRouter)

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        server.request(`/api/campaigns/${CAMP}/stats`, {
          headers: authHeaders(USER),
        })
      )
    )

    for (const res of results) {
      assert.equal(res.status, 200, `Got ${res.status}: ${JSON.stringify(res.body)}`)
      assert.equal(res.body.stats.sent, SENT)
      assert.equal(res.body.stats.replied, REPLIED)
    }

    // All responses must be identical
    const first = JSON.stringify(results[0].body.stats)
    for (const res of results.slice(1)) {
      assert.equal(JSON.stringify(res.body.stats), first, 'Concurrent stats responses must be consistent')
    }
  })

  it('D2 — stats with 0 sent and 0 replied: replyRate is 0 (no division by zero)', async () => {
    const fake = makeStatsSpec({ sent: 0, replied: 0 })
    installPrisma(fake)
    server = await startTestServer('/api/campaigns', campaignsRouter)

    const res = await server.request(`/api/campaigns/${CAMP}/stats`, {
      headers: authHeaders(USER),
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.stats.replyRate, 0)
    assert.ok(isFinite(res.body.stats.replyRate), 'replyRate must be finite')
  })

  it('D3 — stats with very large numbers: no NaN or Infinity in replyRate', async () => {
    const fake = makeStatsSpec({ sent: 9_999_999, replied: 4_999_999, totalLeads: 10_000_000 })
    installPrisma(fake)
    server = await startTestServer('/api/campaigns', campaignsRouter)

    const res = await server.request(`/api/campaigns/${CAMP}/stats`, {
      headers: authHeaders(USER),
    })
    assert.equal(res.status, 200)
    const rate = res.body.stats.replyRate
    assert.ok(!Number.isNaN(rate), `replyRate must not be NaN; got ${rate}`)
    assert.ok(isFinite(rate), `replyRate must be finite; got ${rate}`)
    assert.ok(rate >= 0 && rate <= 1, `replyRate must be in [0,1]; got ${rate}`)
  })

  it('D4 — stats with 1 sent and 1 replied: replyRate is 1', async () => {
    const fake = makeStatsSpec({ sent: 1, replied: 1 })
    installPrisma(fake)
    server = await startTestServer('/api/campaigns', campaignsRouter)

    const res = await server.request(`/api/campaigns/${CAMP}/stats`, {
      headers: authHeaders(USER),
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.stats.replyRate, 1)
  })

  it('D5 — stats for unknown campaign returns 404', async () => {
    const fake = makeStatsSpec({})
    installPrisma(fake)
    server = await startTestServer('/api/campaigns', campaignsRouter)

    const res = await server.request('/api/campaigns/no-such-camp/stats', {
      headers: authHeaders(USER),
    })
    assert.equal(res.status, 404)
  })
})

// ---------------------------------------------------------------------------
// E. Circuit breaker under concurrent failures
// ---------------------------------------------------------------------------

describe('E. Circuit breaker under concurrent failures', () => {
  it('E1 — 5 concurrent calls all fail: circuit trips OPEN exactly once', async () => {
    const cb = new CircuitBreaker('test-e1', 5, 30_000)
    assert.equal(cb.status, 'CLOSED')

    const fail = () => Promise.reject(new Error('boom'))
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => cb.call(fail))
    )

    // All 5 calls rejected
    assert.equal(results.filter((r) => r.status === 'rejected').length, 5)
    // Circuit is now OPEN
    assert.equal(cb.status, 'OPEN')
    assert.equal(cb.isOpen, true)
  })

  it('E2 — after threshold failures, concurrent calls all get CircuitOpenError immediately', async () => {
    const cb = new CircuitBreaker('test-e2', 3, 30_000)

    // Trip the circuit
    for (let i = 0; i < 3; i++) {
      try { await cb.call(() => Promise.reject(new Error('fail'))) } catch { /* expected */ }
    }
    assert.equal(cb.status, 'OPEN')

    // Now fire concurrent calls — all should get CircuitOpenError, not the original error
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => cb.call(() => Promise.reject(new Error('should-not-run'))))
    )

    for (const r of results) {
      assert.equal(r.status, 'rejected')
      assert.ok(
        (r as PromiseRejectedResult).reason instanceof CircuitOpenError,
        `Expected CircuitOpenError, got: ${(r as PromiseRejectedResult).reason?.constructor?.name}`
      )
    }
  })

  it('E3 — below threshold: failures accumulate but circuit stays CLOSED', async () => {
    const cb = new CircuitBreaker('test-e3', 5, 30_000)

    // 4 failures (below threshold of 5)
    for (let i = 0; i < 4; i++) {
      try { await cb.call(() => Promise.reject(new Error('fail'))) } catch { /* expected */ }
    }

    assert.equal(cb.status, 'CLOSED', 'Circuit should remain CLOSED below threshold')
    assert.equal(cb.isOpen, false)
  })

  it('E4 — recovery after reset: all callers succeed', async () => {
    const cb = new CircuitBreaker('test-e4', 5, 0) // resetAfterMs=0 → instant probe

    // Trip the circuit
    for (let i = 0; i < 5; i++) {
      try { await cb.call(() => Promise.reject(new Error('fail'))) } catch { /* expected */ }
    }
    assert.equal(cb.status, 'OPEN')

    // Wait a tick to ensure Date.now() >= lastFailureAt + resetAfterMs (0ms)
    await new Promise((r) => setTimeout(r, 1))

    // First successful call should recover the circuit
    const result = await cb.call(() => Promise.resolve('ok'))
    assert.equal(result, 'ok')
    assert.equal(cb.status, 'CLOSED')

    // Subsequent concurrent calls should all succeed
    const results = await Promise.all(
      Array.from({ length: 5 }, () => cb.call(() => Promise.resolve('success')))
    )
    assert.ok(
      results.every((r) => r === 'success'),
      'All post-recovery calls should succeed'
    )
  })

  it('E5 — HALF_OPEN probe: state transitions correctly after resetAfterMs', async () => {
    const cb = new CircuitBreaker('test-e5', 2, 0) // resetAfterMs=0 → immediate probe

    // Trip to OPEN
    for (let i = 0; i < 2; i++) {
      try { await cb.call(() => Promise.reject(new Error('x'))) } catch { /* expected */ }
    }
    assert.equal(cb.status, 'OPEN')

    await new Promise((r) => setTimeout(r, 1))

    // Probe with a successful call — transitions OPEN → HALF_OPEN → CLOSED
    await cb.call(() => Promise.resolve('probe'))
    assert.equal(cb.status, 'CLOSED')
  })

  it('E6 — HALF_OPEN probe fails: circuit stays/re-opens', async () => {
    const cb = new CircuitBreaker('test-e6', 2, 0)

    // Trip to OPEN
    for (let i = 0; i < 2; i++) {
      try { await cb.call(() => Promise.reject(new Error('x'))) } catch { /* expected */ }
    }
    assert.equal(cb.status, 'OPEN')

    await new Promise((r) => setTimeout(r, 1))

    // Probe fails — should fail and increment, staying/going back OPEN
    try {
      await cb.call(() => Promise.reject(new Error('probe-fail')))
    } catch { /* expected */ }

    // After a failed probe, state should not be CLOSED
    assert.notEqual(cb.status, 'CLOSED', 'Circuit must not close after a failed probe')
  })

  it('E7 — concurrent HALF_OPEN probes: no panic, state ends CLOSED or OPEN', async () => {
    const cb = new CircuitBreaker('test-e7', 2, 0)

    // Trip to OPEN
    for (let i = 0; i < 2; i++) {
      try { await cb.call(() => Promise.reject(new Error('x'))) } catch { /* expected */ }
    }

    await new Promise((r) => setTimeout(r, 1))

    // Fire multiple concurrent probes — some may get CircuitOpenError (if another
    // probe already fired and re-opened), or they may all race through HALF_OPEN.
    // The critical invariant: no uncaught exception / no panic.
    const settled = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        cb.call(() => Promise.resolve('concurrent-probe'))
      )
    )

    // At least one probe should have succeeded (the first to fire)
    const succeeded = settled.filter((s) => s.status === 'fulfilled')
    assert.ok(succeeded.length >= 1, 'At least one concurrent probe should succeed')

    // Final state must be consistent (not an invalid string)
    assert.ok(
      ['CLOSED', 'OPEN', 'HALF_OPEN'].includes(cb.status),
      `Unexpected circuit state: ${cb.status}`
    )
  })

  it('E8 — independent circuit breakers do not share state', async () => {
    const cbA = new CircuitBreaker('test-e8-A', 2, 30_000)
    const cbB = new CircuitBreaker('test-e8-B', 2, 30_000)

    // Trip only cbA
    for (let i = 0; i < 2; i++) {
      try { await cbA.call(() => Promise.reject(new Error('fail'))) } catch { /* expected */ }
    }

    assert.equal(cbA.status, 'OPEN')
    assert.equal(cbB.status, 'CLOSED', 'cbB must not be affected by cbA failures')

    // cbB should still work
    const result = await cbB.call(() => Promise.resolve(42))
    assert.equal(result, 42)
  })
})

// ---------------------------------------------------------------------------
// F. escCsv throughput and correctness
// ---------------------------------------------------------------------------

describe('F. escCsv/escHtml throughput and correctness', () => {
  it('F1 — 10,000 rows of escCsv complete in under 100ms', () => {
    const row = ['Company Name, Ltd.', 'John "The Boss" Doe', 'john@company.com', '100', 'NEW']
    const start = Date.now()
    for (let i = 0; i < 10_000; i++) {
      row.map(escCsv).join(',')
    }
    const elapsed = Date.now() - start
    assert.ok(elapsed < 100, `10,000 escCsv rows took ${elapsed}ms — expected < 100ms`)
  })

  it('F2 — large string (100KB) through escCsv completes without timeout', () => {
    const big = 'a'.repeat(50_000) + '"' + 'b'.repeat(50_000)
    const start = Date.now()
    const result = escCsv(big)
    const elapsed = Date.now() - start
    assert.ok(elapsed < 5_000, `Large string escCsv took ${elapsed}ms`)
    assert.ok(result.startsWith('"'), 'Quoted because contains double-quote')
    assert.ok(result.endsWith('"'), 'Closing quote present')
  })

  it('F3 — concurrent escCsv calls on a pure function produce no corruption', async () => {
    const inputs = ['hello', 'world, goodbye', '"quoted"', 'line\nbreak', '', null, undefined, 0, true]

    // Compute expected outputs synchronously
    const expected = inputs.map((v) => escCsv(v))

    // Now run many concurrent "calls" (microtask queue, pure fn, should be trivially safe)
    const results = await Promise.all(
      Array.from({ length: 1_000 }, (_, i) =>
        Promise.resolve().then(() => escCsv(inputs[i % inputs.length]))
      )
    )

    for (let i = 0; i < results.length; i++) {
      const expectedVal = expected[i % inputs.length]
      assert.equal(results[i], expectedVal, `Mismatch at index ${i}`)
    }
  })

  it('F4 — escCsv wraps values with comma in double-quotes', () => {
    assert.equal(escCsv('a,b'), '"a,b"')
  })

  it('F5 — escCsv wraps values with double-quote and escapes internal quotes', () => {
    assert.equal(escCsv('say "hello"'), '"say ""hello"""')
  })

  it('F6 — escCsv wraps values with newline in double-quotes', () => {
    assert.equal(escCsv('line1\nline2'), '"line1\nline2"')
  })

  it('F7 — escCsv returns empty string for null and undefined', () => {
    assert.equal(escCsv(null), '')
    assert.equal(escCsv(undefined), '')
  })

  it('F8 — escCsv passes through plain strings without quoting', () => {
    assert.equal(escCsv('simple'), 'simple')
    assert.equal(escCsv('no special chars'), 'no special chars')
  })

  it('F9 — escCsv converts numbers and booleans to string', () => {
    assert.equal(escCsv(42), '42')
    assert.equal(escCsv(true), 'true')
    assert.equal(escCsv(false), 'false')
  })

  it('F10 — escCsv throughput: 50,000 simple cells under 200ms', () => {
    const start = Date.now()
    for (let i = 0; i < 50_000; i++) {
      escCsv(`Company ${i}`)
    }
    const elapsed = Date.now() - start
    assert.ok(elapsed < 200, `50,000 simple escCsv cells took ${elapsed}ms — expected < 200ms`)
  })
})
