/**
 * Multi-tenancy stress tests.
 *
 * Verifies that workspace A and workspace B NEVER leak data to each other,
 * even under concurrent load. Each section tests a specific resource type and
 * isolation boundary. All tests use real Express route handlers against a
 * fake Prisma client — no live database or Redis required.
 *
 * Sections:
 *   A. Lead data isolation
 *   B. Campaign isolation
 *   C. ingestCache workspace isolation
 *   D. Membership isolation
 *   E. Scoring model isolation
 *   F. OutreachSent isolation
 *   G. Multi-tenant concurrent write stress
 */

import { describe, it, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  createFakePrisma,
  installPrisma,
  resetPrisma,
  startTestServer,
  bearer,
  type FakePrisma,
  type TestServer,
} from './helpers/integration.ts'
import { leadsRouter } from '../apps/api/src/routes/leads.ts'
import { campaignsRouter } from '../apps/api/src/routes/campaigns.ts'
import { ingestRouter } from '../apps/api/src/routes/ingest.ts'
import { workspaceRouter } from '../apps/api/src/routes/workspaces.ts'
import {
  getCachedWorkspace,
  setCachedWorkspace,
  evictCachedWorkspace,
} from '../apps/api/src/lib/ingestCache.ts'
import { hashApiKey } from '../apps/api/src/lib/apiKeys.ts'

// ── Environment ────────────────────────────────────────────────────────────────
process.env.JWT_SECRET = 'test-multi-tenancy-stress-secret-32ch'
process.env.NODE_ENV = 'test'

// ── Shared fixtures ────────────────────────────────────────────────────────────
const USER_A = 'user-alpha-mt-001'
const USER_B = 'user-bravo-mt-002'
const USER_C = 'user-charlie-mt-003'   // belongs to neither workspace initially
const WS_A   = 'workspace-alpha-mt'
const WS_B   = 'workspace-bravo-mt'

// Stable API keys (raw) and their hashes for ingest tests
const RAW_KEY_A  = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const RAW_KEY_B  = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const HASH_KEY_A = hashApiKey(RAW_KEY_A)
const HASH_KEY_B = hashApiKey(RAW_KEY_B)

// Helper: build a minimal user lookup stub that covers USER_A, USER_B, and USER_C
const userLookup = {
  findUnique: async (args: any) => {
    const db: Record<string, object> = {
      [USER_A]: { id: USER_A, email: 'alpha@test.com', name: 'Alpha', emailVerified: true },
      [USER_B]: { id: USER_B, email: 'bravo@test.com', name: 'Bravo', emailVerified: true },
      [USER_C]: { id: USER_C, email: 'charlie@test.com', name: 'Charlie', emailVerified: true },
    }
    // Support lookup by id or by email
    if (args?.where?.id) return db[args.where.id] ?? null
    if (args?.where?.email) {
      return Object.values(db).find((u: any) => u.email === args.where.email) ?? null
    }
    return null
  },
}

// Helper: membership that gives USER_A access to WS_A only, USER_B to WS_B only
function strictMembership(role: 'owner' | 'member' | 'admin' = 'member') {
  return {
    findFirst: async (args: any) => {
      const { userId, workspaceId } = args?.where ?? {}
      // Role filter may be present (e.g. { role: { in: ['owner','admin'] } })
      const roleFilter: string[] | undefined = args?.where?.role?.in
      const resolveRole = (uid: string, wsid: string): string | null => {
        if (uid === USER_A && wsid === WS_A) return role
        if (uid === USER_B && wsid === WS_B) return role
        return null
      }
      const r = resolveRole(userId, workspaceId)
      if (!r) return null
      if (roleFilter && !roleFilter.includes(r)) return null
      return { id: `m-${userId}-${workspaceId}`, userId, workspaceId, role: r }
    },
    findMany: async (args: any) => {
      const { workspaceId } = args?.where ?? {}
      if (workspaceId === WS_A) return [{ id: `m-${USER_A}-${WS_A}`, userId: USER_A, workspaceId: WS_A, role, createdAt: new Date(), user: { id: USER_A, email: 'alpha@test.com', name: 'Alpha' } }]
      if (workspaceId === WS_B) return [{ id: `m-${USER_B}-${WS_B}`, userId: USER_B, workspaceId: WS_B, role, createdAt: new Date(), user: { id: USER_B, email: 'bravo@test.com', name: 'Bravo' } }]
      return []
    },
    create: async (args: any) => ({ id: 'new-member-id', ...args?.data }),
  }
}

// ── Helper: build a lead record ────────────────────────────────────────────────
function makeLead(id: string, workspaceId: string, overrides: object = {}) {
  return {
    id,
    workspaceId,
    businessName: `Business ${id}`,
    score: 50,
    stage: 'NEW',
    email: null,
    contactName: null,
    website: null,
    city: null,
    category: null,
    notes: null,
    aiSummary: null,
    outreachAngle: null,
    campaignId: null,
    sourceTag: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

// ── Helper: build a campaign record ───────────────────────────────────────────
function makeCampaign(id: string, workspaceId: string, overrides: object = {}) {
  return {
    id,
    workspaceId,
    name: `Campaign ${id}`,
    goalType: 'BOOK_CALL',
    createdAt: new Date(),
    updatedAt: new Date(),
    _count: { leads: 0 },
    ...overrides,
  }
}

// ── Helper: build an outreachSent record ──────────────────────────────────────
function makeOutreach(id: string, campaignId: string, overrides: object = {}) {
  return {
    id,
    campaignId,
    toEmail: `contact-${id}@example.com`,
    subject: `Subject ${id}`,
    status: 'SENT',
    sentAt: new Date(),
    repliedAt: null,
    replyIntent: null,
    leadId: `lead-for-${id}`,
    ...overrides,
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// A. Lead data isolation
// ═══════════════════════════════════════════════════════════════════════════════

describe('A. Lead data isolation', () => {
  // Build 10 leads in WS_A and 5 in WS_B
  const leadsA = Array.from({ length: 10 }, (_, i) => makeLead(`lead-a-${i + 1}`, WS_A))
  const leadsB = Array.from({ length: 5 },  (_, i) => makeLead(`lead-b-${i + 1}`, WS_B))
  const allLeadsById = new Map([...leadsA, ...leadsB].map((l) => [l.id, l]))

  let prisma: FakePrisma
  let server: TestServer

  before(async () => {
    prisma = createFakePrisma({
      user: userLookup,
      membership: strictMembership(),
      workspace: {
        findUnique: async (args: any) => {
          if (args?.where?.id === WS_A) return { id: WS_A, plan: 'growth', subscriptionStatus: 'active' }
          if (args?.where?.id === WS_B) return { id: WS_B, plan: 'growth', subscriptionStatus: 'active' }
          return null
        },
      },
      scoringModel: {
        findUnique: async () => null,
      },
      lead: {
        findMany: async (args: any) => {
          const wsId = args?.where?.workspaceId
          if (wsId === WS_A) return leadsA
          if (wsId === WS_B) return leadsB
          return []
        },
        count: async (args: any) => {
          const wsId = args?.where?.workspaceId
          if (wsId === WS_A) return leadsA.length
          if (wsId === WS_B) return leadsB.length
          return 0
        },
        findUnique: async (args: any) => allLeadsById.get(args?.where?.id) ?? null,
        update: async (args: any) => {
          const lead = allLeadsById.get(args?.where?.id)
          if (!lead) return null
          return { ...lead, ...args?.data }
        },
        delete: async (args: any) => allLeadsById.get(args?.where?.id) ?? null,
      },
    })
    installPrisma(prisma)
    server = await startTestServer('/api/leads', leadsRouter)
  })

  after(async () => {
    await server.close()
    resetPrisma()
  })

  it('GET /api/leads for WS_A returns exactly 10 leads', async () => {
    const r = await server.request('/api/leads?workspaceId=' + WS_A, {
      headers: { Authorization: bearer(USER_A) },
    })
    assert.equal(r.status, 200, `Expected 200 got ${r.status}: ${JSON.stringify(r.body)}`)
    assert.equal(r.body.leads.length, 10)
    assert.equal(r.body.total, 10)
    // All leads must belong to WS_A
    for (const lead of r.body.leads) {
      assert.equal(lead.workspaceId, WS_A, `Lead ${lead.id} leaked from wrong workspace`)
    }
  })

  it('GET /api/leads for WS_B returns exactly 5 leads', async () => {
    const r = await server.request('/api/leads?workspaceId=' + WS_B, {
      headers: { Authorization: bearer(USER_B) },
    })
    assert.equal(r.status, 200)
    assert.equal(r.body.leads.length, 5)
    assert.equal(r.body.total, 5)
    for (const lead of r.body.leads) {
      assert.equal(lead.workspaceId, WS_B)
    }
  })

  it('Concurrent GET /api/leads from A and B simultaneously — no mixing of results', async () => {
    const [rA, rB] = await Promise.all([
      server.request('/api/leads?workspaceId=' + WS_A, { headers: { Authorization: bearer(USER_A) } }),
      server.request('/api/leads?workspaceId=' + WS_B, { headers: { Authorization: bearer(USER_B) } }),
    ])
    assert.equal(rA.status, 200)
    assert.equal(rB.status, 200)
    // No WS_B leads should appear in WS_A's response
    const idsA = new Set(rA.body.leads.map((l: any) => l.id))
    const idsB = new Set(rB.body.leads.map((l: any) => l.id))
    for (const id of idsA) assert.ok(!idsB.has(id), `Lead ${id} appears in both workspaces`)
    assert.equal(rA.body.leads.length, 10)
    assert.equal(rB.body.leads.length, 5)
  })

  it('User A cannot GET leads from workspace B (403)', async () => {
    const r = await server.request('/api/leads?workspaceId=' + WS_B, {
      headers: { Authorization: bearer(USER_A) },
    })
    assert.equal(r.status, 403)
  })

  it('User A cannot GET a specific lead belonging to workspace B (403)', async () => {
    const r = await server.request('/api/leads/lead-b-1', {
      headers: { Authorization: bearer(USER_A) },
    })
    assert.equal(r.status, 403)
  })

  it('User A cannot PATCH a lead belonging to workspace B (403, no update called)', async () => {
    const r = await server.request('/api/leads/lead-b-1', {
      method: 'PATCH',
      headers: { Authorization: bearer(USER_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: 'DEAD' }),
    })
    assert.equal(r.status, 403)
    assert.equal(prisma.callsTo('lead', 'update').length, 0, 'lead.update must never be called')
  })

  it('User A cannot DELETE a lead belonging to workspace B (403, no delete called)', async () => {
    const r = await server.request('/api/leads/lead-b-1', {
      method: 'DELETE',
      headers: { Authorization: bearer(USER_A) },
    })
    assert.equal(r.status, 403)
    assert.equal(prisma.callsTo('lead', 'delete').length, 0, 'lead.delete must never be called')
  })

  it('Multiple concurrent cross-workspace access attempts all return 403', async () => {
    const requests = Array.from({ length: 6 }, (_, i) => {
      // User A trying leads from WS_B
      const leadId = `lead-b-${(i % 5) + 1}`
      return server.request(`/api/leads/${leadId}`, {
        headers: { Authorization: bearer(USER_A) },
      })
    })
    const results = await Promise.all(requests)
    for (const r of results) {
      assert.equal(r.status, 403, 'All cross-workspace requests must be 403')
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// B. Campaign isolation
// ═══════════════════════════════════════════════════════════════════════════════

describe('B. Campaign isolation', () => {
  const campaignA = makeCampaign('campaign-a-1', WS_A, { _count: { leads: 3 } })
  const campaignB = makeCampaign('campaign-b-1', WS_B, { _count: { leads: 7 } })

  const outreachA = [
    makeOutreach('out-a-1', 'campaign-a-1'),
    makeOutreach('out-a-2', 'campaign-a-1'),
  ]
  const outreachB = [
    makeOutreach('out-b-1', 'campaign-b-1'),
    makeOutreach('out-b-2', 'campaign-b-1'),
    makeOutreach('out-b-3', 'campaign-b-1'),
  ]

  let prismaA: FakePrisma
  let server: TestServer

  before(async () => {
    // We use a single prisma that can answer for both workspaces
    // (membership guards handle the access control)
    prismaA = createFakePrisma({
      user: userLookup,
      membership: strictMembership('owner'),
      campaign: {
        findUnique: async (args: any) => {
          if (args?.where?.id === 'campaign-a-1') return campaignA
          if (args?.where?.id === 'campaign-b-1') return campaignB
          return null
        },
        findMany: async (args: any) => {
          const wsId = args?.where?.workspaceId
          if (wsId === WS_A) return [campaignA]
          if (wsId === WS_B) return [campaignB]
          return []
        },
        create: async (args: any) => ({
          id: `new-campaign-${Date.now()}-${Math.random()}`,
          ...args?.data,
          createdAt: new Date(),
          updatedAt: new Date(),
          _count: { leads: 0 },
        }),
        update: async (args: any) => ({ ...campaignA, ...args?.data }),
        delete: async () => ({}),
      },
      lead: {
        count: async (args: any) => {
          const campaignId = args?.where?.campaignId
          if (campaignId === 'campaign-a-1') return 2
          if (campaignId === 'campaign-b-1') return 3
          return 0
        },
      },
      outreachSent: {
        count: async (args: any) => {
          const campaignId = args?.where?.campaignId
          const status = args?.where?.status
          if (campaignId === 'campaign-a-1') {
            if (status === 'REPLIED') return 1
            return outreachA.length
          }
          if (campaignId === 'campaign-b-1') {
            if (status === 'REPLIED') return 2
            return outreachB.length
          }
          return 0
        },
        findMany: async (args: any) => {
          const campaignId = args?.where?.campaignId
          if (campaignId === 'campaign-a-1') return outreachA
          if (campaignId === 'campaign-b-1') return outreachB
          return []
        },
      },
    })
    installPrisma(prismaA)
    server = await startTestServer('/api/campaigns', campaignsRouter)
  })

  after(async () => {
    await server.close()
    resetPrisma()
  })

  it('GET /api/campaigns for WS_A returns only WS_A campaigns', async () => {
    const r = await server.request('/api/campaigns?workspaceId=' + WS_A, {
      headers: { Authorization: bearer(USER_A) },
    })
    assert.equal(r.status, 200)
    assert.equal(r.body.campaigns.length, 1)
    assert.equal(r.body.campaigns[0].id, 'campaign-a-1')
    assert.equal(r.body.campaigns[0].workspaceId, WS_A)
  })

  it('GET /api/campaigns for WS_B returns only WS_B campaigns', async () => {
    const r = await server.request('/api/campaigns?workspaceId=' + WS_B, {
      headers: { Authorization: bearer(USER_B) },
    })
    assert.equal(r.status, 200)
    assert.equal(r.body.campaigns.length, 1)
    assert.equal(r.body.campaigns[0].id, 'campaign-b-1')
    assert.equal(r.body.campaigns[0].workspaceId, WS_B)
  })

  it('GET /api/campaigns/:id for campaign in WS_B by WS_A user → 403', async () => {
    const r = await server.request('/api/campaigns/campaign-b-1', {
      headers: { Authorization: bearer(USER_A) },
    })
    assert.equal(r.status, 403)
  })

  it('Campaign A stats show only workspace A outreach records', async () => {
    const r = await server.request('/api/campaigns/campaign-a-1/stats', {
      headers: { Authorization: bearer(USER_A) },
    })
    assert.equal(r.status, 200)
    assert.equal(r.body.stats.sent, outreachA.length)
    assert.equal(r.body.stats.replied, 1)
  })

  it('Campaign B stats show only workspace B outreach records', async () => {
    const r = await server.request('/api/campaigns/campaign-b-1/stats', {
      headers: { Authorization: bearer(USER_B) },
    })
    assert.equal(r.status, 200)
    assert.equal(r.body.stats.sent, outreachB.length)
    assert.equal(r.body.stats.replied, 2)
  })

  it('POST /api/campaigns/:id/send for WS_B campaign by WS_A user → 403', async () => {
    const r = await server.request('/api/campaigns/campaign-b-1/send', {
      method: 'POST',
      headers: { Authorization: bearer(USER_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(r.status, 403)
  })

  it('Concurrent campaign create in both workspaces — IDs are distinct, no collision', async () => {
    const [rA, rB] = await Promise.all([
      server.request('/api/campaigns', {
        method: 'POST',
        headers: { Authorization: bearer(USER_A), 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: WS_A, name: 'Concurrent Campaign A' }),
      }),
      server.request('/api/campaigns', {
        method: 'POST',
        headers: { Authorization: bearer(USER_B), 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: WS_B, name: 'Concurrent Campaign B' }),
      }),
    ])
    assert.equal(rA.status, 201)
    assert.equal(rB.status, 201)
    const idA = rA.body.campaign?.id
    const idB = rB.body.campaign?.id
    assert.ok(idA, 'Campaign A must have an id')
    assert.ok(idB, 'Campaign B must have an id')
    assert.notEqual(idA, idB, 'Concurrent campaign creates must produce distinct IDs')
  })

  it('Concurrent GET for WS_A campaign and WS_B campaign — no cross-contamination', async () => {
    const [rA, rB] = await Promise.all([
      server.request('/api/campaigns/campaign-a-1', { headers: { Authorization: bearer(USER_A) } }),
      server.request('/api/campaigns/campaign-b-1', { headers: { Authorization: bearer(USER_B) } }),
    ])
    assert.equal(rA.status, 200)
    assert.equal(rB.status, 200)
    assert.equal(rA.body.campaign.workspaceId, WS_A)
    assert.equal(rB.body.campaign.workspaceId, WS_B)
    assert.notEqual(rA.body.campaign.id, rB.body.campaign.id)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// C. ingestCache workspace isolation (unit-level — no HTTP server needed)
// ═══════════════════════════════════════════════════════════════════════════════

describe('C. ingestCache workspace isolation', () => {
  afterEach(() => {
    // Clean cache entries after each test
    evictCachedWorkspace(HASH_KEY_A)
    evictCachedWorkspace(HASH_KEY_B)
  })

  it('getCachedWorkspace returns null for unknown hash', () => {
    const result = getCachedWorkspace('nonexistent-hash-xyz')
    assert.equal(result, null)
  })

  it('setCachedWorkspace for WS_A is retrievable by its hash only', () => {
    setCachedWorkspace(HASH_KEY_A, { id: WS_A, plan: 'growth' })
    const resultA = getCachedWorkspace(HASH_KEY_A)
    const resultB = getCachedWorkspace(HASH_KEY_B)
    assert.deepEqual(resultA, { id: WS_A, plan: 'growth' })
    assert.equal(resultB, null, 'WS_B hash must not return WS_A workspace')
  })

  it('setCachedWorkspace for WS_B is retrievable by its hash only', () => {
    setCachedWorkspace(HASH_KEY_B, { id: WS_B, plan: 'starter' })
    const resultA = getCachedWorkspace(HASH_KEY_A)
    const resultB = getCachedWorkspace(HASH_KEY_B)
    assert.equal(resultA, null, 'WS_A hash must not return WS_B workspace')
    assert.deepEqual(resultB, { id: WS_B, plan: 'starter' })
  })

  it('Both workspaces cached independently — each returns its own data', () => {
    setCachedWorkspace(HASH_KEY_A, { id: WS_A, plan: 'growth' })
    setCachedWorkspace(HASH_KEY_B, { id: WS_B, plan: 'free' })
    const resultA = getCachedWorkspace(HASH_KEY_A)
    const resultB = getCachedWorkspace(HASH_KEY_B)
    assert.equal(resultA?.id, WS_A)
    assert.equal(resultB?.id, WS_B)
    assert.notEqual(resultA?.id, resultB?.id)
  })

  it('After evicting WS_A, WS_B cache entry is unaffected', () => {
    setCachedWorkspace(HASH_KEY_A, { id: WS_A, plan: 'growth' })
    setCachedWorkspace(HASH_KEY_B, { id: WS_B, plan: 'starter' })
    evictCachedWorkspace(HASH_KEY_A)
    assert.equal(getCachedWorkspace(HASH_KEY_A), null, 'WS_A must be evicted')
    assert.deepEqual(getCachedWorkspace(HASH_KEY_B), { id: WS_B, plan: 'starter' }, 'WS_B must still be cached')
  })

  it('Concurrent cache writes for A and B both land in the right slot', async () => {
    await Promise.all([
      Promise.resolve(setCachedWorkspace(HASH_KEY_A, { id: WS_A, plan: 'growth' })),
      Promise.resolve(setCachedWorkspace(HASH_KEY_B, { id: WS_B, plan: 'free' })),
    ])
    assert.equal(getCachedWorkspace(HASH_KEY_A)?.id, WS_A)
    assert.equal(getCachedWorkspace(HASH_KEY_B)?.id, WS_B)
  })

  it('WS_A key cannot be used to retrieve WS_B workspace from cache', () => {
    setCachedWorkspace(HASH_KEY_B, { id: WS_B, plan: 'starter' })
    // Trying to look up WS_B using WS_A's hash must return null
    const usingWrongKey = getCachedWorkspace(HASH_KEY_A)
    assert.equal(usingWrongKey, null)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// C2. ingestCache + ingest route integration
// ═══════════════════════════════════════════════════════════════════════════════

describe('C2. Ingest route workspace isolation', () => {
  // Shared state: tracks which workspace leads were inserted into
  const insertedLeads: Array<{ workspaceId: string; businessName: string }> = []

  let server: TestServer
  let prisma: FakePrisma

  before(async () => {
    // Clear cache entries for these keys before starting
    evictCachedWorkspace(HASH_KEY_A)
    evictCachedWorkspace(HASH_KEY_B)

    prisma = createFakePrisma({
      user: userLookup,
      workspace: {
        findUnique: async (args: any) => {
          // Lookup by ingestApiKey hash
          if (args?.where?.ingestApiKey === HASH_KEY_A) return { id: WS_A, plan: 'growth' }
          if (args?.where?.ingestApiKey === HASH_KEY_B) return { id: WS_B, plan: 'growth' }
          if (args?.where?.id === WS_A) return { id: WS_A, plan: 'growth', subscriptionStatus: 'active', ingestApiKey: HASH_KEY_A }
          if (args?.where?.id === WS_B) return { id: WS_B, plan: 'growth', subscriptionStatus: 'active', ingestApiKey: HASH_KEY_B }
          return null
        },
        update: async (args: any) => ({ id: args?.where?.id, ...args?.data }),
      },
      membership: {
        findFirst: async (args: any) => {
          const { userId, workspaceId } = args?.where ?? {}
          if (userId === USER_A && workspaceId === WS_A) return { id: `m-${USER_A}-${WS_A}`, userId, workspaceId, role: 'owner' }
          if (userId === USER_B && workspaceId === WS_B) return { id: `m-${USER_B}-${WS_B}`, userId, workspaceId, role: 'owner' }
          return null
        },
        count: async () => 1, // below the seat cap
      },
      lead: {
        findMany: async () => [],
        create: async (args: any) => {
          const lead = { id: `ingested-${Date.now()}-${Math.random()}`, ...args?.data, createdAt: new Date(), updatedAt: new Date(), stage: 'NEW', score: 0 }
          insertedLeads.push({ workspaceId: lead.workspaceId, businessName: lead.businessName })
          return lead
        },
        createMany: async (args: any) => ({ count: (args?.data ?? []).length }),
        count: async () => 0,
      },
      usageRecord: {
        findMany: async () => [],
        upsert: async () => ({}),
      },
      campaign: {
        findFirst: async () => null,
      },
    })

    // Override $transaction for ingest route (it uses prisma.$transaction(array))
    ;(prisma as any).$transaction = async (arg: unknown) => {
      if (Array.isArray(arg)) return Promise.all(arg)
      return (arg as (tx: unknown) => unknown)(prisma)
    }

    installPrisma(prisma)
    server = await startTestServer('/api/ingest', ingestRouter)
  })

  after(async () => {
    await server.close()
    evictCachedWorkspace(HASH_KEY_A)
    evictCachedWorkspace(HASH_KEY_B)
    resetPrisma()
  })

  it('API key for WS_A cannot ingest into WS_B (key resolves to own workspace only)', async () => {
    insertedLeads.length = 0
    // Use WS_A's key — leads should go into WS_A regardless
    const r = await server.request('/api/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': RAW_KEY_A },
      body: JSON.stringify({ leads: [{ businessName: 'Infiltrator Inc' }], autoResearch: false }),
    })
    assert.equal(r.status, 201)
    // All leads inserted must be in WS_A — never in WS_B
    for (const lead of insertedLeads) {
      assert.equal(lead.workspaceId, WS_A, 'WS_A key must only insert into WS_A')
    }
  })

  it('Invalid API key is rejected with 401', async () => {
    const r = await server.request('/api/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'totally-invalid-key' },
      body: JSON.stringify({ leads: [{ businessName: 'Evil Corp' }], autoResearch: false }),
    })
    assert.equal(r.status, 401)
  })

  it('WS_B key works independently after setup', async () => {
    insertedLeads.length = 0
    evictCachedWorkspace(HASH_KEY_B) // ensure fresh DB lookup
    const r = await server.request('/api/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': RAW_KEY_B },
      body: JSON.stringify({ leads: [{ businessName: 'Bravo Lead Co' }], autoResearch: false }),
    })
    assert.equal(r.status, 201)
    for (const lead of insertedLeads) {
      assert.equal(lead.workspaceId, WS_B, 'WS_B key must only insert into WS_B')
    }
  })

  it('Concurrent ingest from WS_A and WS_B — leads go to correct workspaces', async () => {
    insertedLeads.length = 0
    evictCachedWorkspace(HASH_KEY_A)
    evictCachedWorkspace(HASH_KEY_B)

    await Promise.all([
      server.request('/api/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': RAW_KEY_A },
        body: JSON.stringify({
          leads: [{ businessName: 'Alpha Lead 1' }, { businessName: 'Alpha Lead 2' }],
          autoResearch: false,
        }),
      }),
      server.request('/api/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': RAW_KEY_B },
        body: JSON.stringify({
          leads: [{ businessName: 'Bravo Lead 1' }, { businessName: 'Bravo Lead 2' }],
          autoResearch: false,
        }),
      }),
    ])

    const alphaLeads = insertedLeads.filter((l) => l.businessName.startsWith('Alpha'))
    const bravoLeads = insertedLeads.filter((l) => l.businessName.startsWith('Bravo'))

    for (const l of alphaLeads) assert.equal(l.workspaceId, WS_A, 'Alpha leads must be in WS_A')
    for (const l of bravoLeads) assert.equal(l.workspaceId, WS_B, 'Bravo leads must be in WS_B')
    assert.equal(alphaLeads.length, 2)
    assert.equal(bravoLeads.length, 2)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// D. Membership isolation
// ═══════════════════════════════════════════════════════════════════════════════

describe('D. Membership isolation', () => {
  let server: TestServer

  before(async () => {
    const prisma = createFakePrisma({
      user: userLookup,
      membership: {
        findFirst: async (args: any) => {
          const { userId, workspaceId } = args?.where ?? {}
          const roleFilter: string[] | undefined = args?.where?.role?.in
          const resolveRole = (uid: string, wsid: string): string | null => {
            if (uid === USER_A && wsid === WS_A) return 'owner'
            if (uid === USER_B && wsid === WS_B) return 'owner'
            // USER_C belongs to neither
            return null
          }
          const role = resolveRole(userId, workspaceId)
          if (!role) return null
          if (roleFilter && !roleFilter.includes(role)) return null
          return { id: `m-${userId}-${workspaceId}`, userId, workspaceId, role }
        },
        findMany: async (args: any) => {
          const wsId = args?.where?.workspaceId
          if (wsId === WS_A) return [{ id: `m-${USER_A}-${WS_A}`, userId: USER_A, workspaceId: WS_A, role: 'owner', createdAt: new Date(), user: { id: USER_A, email: 'alpha@test.com', name: 'Alpha' } }]
          if (wsId === WS_B) return [{ id: `m-${USER_B}-${WS_B}`, userId: USER_B, workspaceId: WS_B, role: 'owner', createdAt: new Date(), user: { id: USER_B, email: 'bravo@test.com', name: 'Bravo' } }]
          return []
        },
        create: async (args: any) => ({ id: 'new-membership-id', ...args?.data }),
        count: async () => 1, // below the seat cap
      },
      workspace: {
        findUnique: async (args: any) => {
          if (args?.where?.id === WS_A) return { id: WS_A, name: 'Alpha Workspace', slug: 'alpha', plan: 'growth', subscriptionStatus: 'active', createdAt: new Date(), updatedAt: new Date(), _count: { leads: 0, campaigns: 0 } }
          if (args?.where?.id === WS_B) return { id: WS_B, name: 'Bravo Workspace', slug: 'bravo', plan: 'growth', subscriptionStatus: 'active', createdAt: new Date(), updatedAt: new Date(), _count: { leads: 0, campaigns: 0 } }
          return null
        },
        findMany: async () => [],
        update: async (args: any) => ({ id: args?.where?.id }),
      },
    })
    installPrisma(prisma)
    server = await startTestServer('/api/workspaces', workspaceRouter)
  })

  after(async () => {
    await server.close()
    resetPrisma()
  })

  it('User belonging to WS_A cannot access WS_B workspace details', async () => {
    const r = await server.request('/api/workspaces/' + WS_B, {
      headers: { Authorization: bearer(USER_A) },
    })
    assert.equal(r.status, 403)
  })

  it('User belonging to WS_B cannot access WS_A workspace details', async () => {
    const r = await server.request('/api/workspaces/' + WS_A, {
      headers: { Authorization: bearer(USER_B) },
    })
    assert.equal(r.status, 403)
  })

  it('User C (belongs to neither workspace) cannot access WS_A', async () => {
    const r = await server.request('/api/workspaces/' + WS_A, {
      headers: { Authorization: bearer(USER_C) },
    })
    assert.equal(r.status, 403)
  })

  it('User C (belongs to neither workspace) cannot access WS_B', async () => {
    const r = await server.request('/api/workspaces/' + WS_B, {
      headers: { Authorization: bearer(USER_C) },
    })
    assert.equal(r.status, 403)
  })

  it('Owner of WS_A can invite user to WS_A — workspace B unaffected', async () => {
    const r = await server.request('/api/workspaces/' + WS_A + '/members', {
      method: 'POST',
      headers: { Authorization: bearer(USER_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'charlie@test.com' }),
    })
    // Should succeed (201) since USER_A is owner of WS_A
    assert.equal(r.status, 201, `Expected 201 got ${r.status}: ${JSON.stringify(r.body)}`)
  })

  it('Concurrent membership checks from same user for WS_A and WS_B return correct access', async () => {
    const [rA, rB] = await Promise.all([
      server.request('/api/workspaces/' + WS_A, { headers: { Authorization: bearer(USER_A) } }),
      server.request('/api/workspaces/' + WS_B, { headers: { Authorization: bearer(USER_A) } }),
    ])
    assert.equal(rA.status, 200, 'USER_A has access to WS_A')
    assert.equal(rB.status, 403, 'USER_A does not have access to WS_B')
  })

  it('GET /api/workspaces/:id/members — WS_A member list not visible to WS_B user', async () => {
    const r = await server.request('/api/workspaces/' + WS_A + '/members', {
      headers: { Authorization: bearer(USER_B) },
    })
    assert.equal(r.status, 403)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// E. Scoring model isolation
// ═══════════════════════════════════════════════════════════════════════════════

describe('E. Scoring model isolation via leads route', () => {
  // Each workspace has its own scoring model weights
  const weightsA = { hasEmail: 30, hasWebsite: 10, hasPhone: 10, hasContactName: 10, hasAiSummary: 15, hasNotes: 5, hasCategory: 5, hasCity: 5, hasOutreachAngle: 10 }
  const weightsB = { hasEmail: 20, hasWebsite: 5, hasPhone: 5, hasContactName: 15, hasAiSummary: 20, hasNotes: 10, hasCategory: 10, hasCity: 5, hasOutreachAngle: 10 }

  let capturedWeightLookups: string[] = []
  let server: TestServer

  before(async () => {
    capturedWeightLookups = []
    const prisma = createFakePrisma({
      user: userLookup,
      membership: strictMembership('owner'),
      workspace: {
        findUnique: async (args: any) => {
          if (args?.where?.id === WS_A) return { id: WS_A, plan: 'growth', subscriptionStatus: 'active' }
          if (args?.where?.id === WS_B) return { id: WS_B, plan: 'growth', subscriptionStatus: 'active' }
          return null
        },
      },
      scoringModel: {
        findUnique: async (args: any) => {
          const wsId = args?.where?.workspaceId
          capturedWeightLookups.push(wsId)
          if (wsId === WS_A) return { workspaceId: WS_A, weights: weightsA }
          if (wsId === WS_B) return { workspaceId: WS_B, weights: weightsB }
          return null
        },
      },
      lead: {
        create: async (args: any) => ({
          id: `lead-scored-${Date.now()}`,
          ...args?.data,
          stage: 'NEW',
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
        count: async () => 0,
      },
    })
    installPrisma(prisma)
    server = await startTestServer('/api/leads', leadsRouter)
  })

  after(async () => {
    await server.close()
    resetPrisma()
  })

  it('Creating a lead in WS_A uses WS_A scoring model, not WS_B', async () => {
    capturedWeightLookups = []
    const r = await server.request('/api/leads', {
      method: 'POST',
      headers: { Authorization: bearer(USER_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: WS_A, businessName: 'Alpha Co', email: 'a@alpha.com' }),
    })
    assert.equal(r.status, 201)
    // The scoring model must only have been fetched for WS_A
    assert.ok(capturedWeightLookups.includes(WS_A), 'WS_A scoring model must be queried')
    assert.ok(!capturedWeightLookups.includes(WS_B), 'WS_B scoring model must NOT be queried')
  })

  it('Creating a lead in WS_B uses WS_B scoring model, not WS_A', async () => {
    capturedWeightLookups = []
    const r = await server.request('/api/leads', {
      method: 'POST',
      headers: { Authorization: bearer(USER_B), 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: WS_B, businessName: 'Bravo Co', email: 'b@bravo.com' }),
    })
    assert.equal(r.status, 201)
    assert.ok(capturedWeightLookups.includes(WS_B), 'WS_B scoring model must be queried')
    assert.ok(!capturedWeightLookups.includes(WS_A), 'WS_A scoring model must NOT be queried')
  })

  it('Concurrent lead creation in A and B use their own scoring models independently', async () => {
    capturedWeightLookups = []
    const [rA, rB] = await Promise.all([
      server.request('/api/leads', {
        method: 'POST',
        headers: { Authorization: bearer(USER_A), 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: WS_A, businessName: 'Concurrent Alpha' }),
      }),
      server.request('/api/leads', {
        method: 'POST',
        headers: { Authorization: bearer(USER_B), 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: WS_B, businessName: 'Concurrent Bravo' }),
      }),
    ])
    assert.equal(rA.status, 201)
    assert.equal(rB.status, 201)
    assert.ok(capturedWeightLookups.includes(WS_A))
    assert.ok(capturedWeightLookups.includes(WS_B))
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// F. OutreachSent isolation
// ═══════════════════════════════════════════════════════════════════════════════

describe('F. OutreachSent isolation', () => {
  const campaignA = makeCampaign('f-campaign-a', WS_A)
  const campaignB = makeCampaign('f-campaign-b', WS_B)

  const outreachA = Array.from({ length: 4 }, (_, i) => makeOutreach(`f-out-a-${i + 1}`, 'f-campaign-a'))
  const outreachB = Array.from({ length: 6 }, (_, i) => makeOutreach(`f-out-b-${i + 1}`, 'f-campaign-b'))

  let server: TestServer

  before(async () => {
    const prisma = createFakePrisma({
      user: userLookup,
      membership: strictMembership('owner'),
      campaign: {
        findUnique: async (args: any) => {
          if (args?.where?.id === 'f-campaign-a') return campaignA
          if (args?.where?.id === 'f-campaign-b') return campaignB
          return null
        },
      },
      outreachSent: {
        findMany: async (args: any) => {
          const campaignId = args?.where?.campaignId
          if (campaignId === 'f-campaign-a') return outreachA
          if (campaignId === 'f-campaign-b') return outreachB
          return []
        },
        count: async (args: any) => {
          const campaignId = args?.where?.campaignId
          if (campaignId === 'f-campaign-a') return outreachA.length
          if (campaignId === 'f-campaign-b') return outreachB.length
          return 0
        },
      },
    })
    installPrisma(prisma)
    server = await startTestServer('/api/campaigns', campaignsRouter)
  })

  after(async () => {
    await server.close()
    resetPrisma()
  })

  it('GET /api/campaigns/:id/outreach for WS_A campaign returns only WS_A records', async () => {
    const r = await server.request('/api/campaigns/f-campaign-a/outreach', {
      headers: { Authorization: bearer(USER_A) },
    })
    assert.equal(r.status, 200)
    assert.equal(r.body.total, outreachA.length)
    assert.equal(r.body.outreach.length, outreachA.length)
    const ids = r.body.outreach.map((o: any) => o.id)
    for (const id of ids) {
      assert.ok(id.startsWith('f-out-a-'), `Unexpected outreach record id: ${id}`)
    }
  })

  it('GET /api/campaigns/:id/outreach for WS_B campaign returns only WS_B records', async () => {
    const r = await server.request('/api/campaigns/f-campaign-b/outreach', {
      headers: { Authorization: bearer(USER_B) },
    })
    assert.equal(r.status, 200)
    assert.equal(r.body.total, outreachB.length)
    assert.equal(r.body.outreach.length, outreachB.length)
    const ids = r.body.outreach.map((o: any) => o.id)
    for (const id of ids) {
      assert.ok(id.startsWith('f-out-b-'), `Unexpected outreach record id: ${id}`)
    }
  })

  it('WS_A user cannot view outreach for WS_B campaign (403)', async () => {
    const r = await server.request('/api/campaigns/f-campaign-b/outreach', {
      headers: { Authorization: bearer(USER_A) },
    })
    assert.equal(r.status, 403)
  })

  it('WS_B user cannot view outreach for WS_A campaign (403)', async () => {
    const r = await server.request('/api/campaigns/f-campaign-a/outreach', {
      headers: { Authorization: bearer(USER_B) },
    })
    assert.equal(r.status, 403)
  })

  it('Concurrent outreach log requests from A and B — no cross-contamination', async () => {
    const [rA, rB] = await Promise.all([
      server.request('/api/campaigns/f-campaign-a/outreach', { headers: { Authorization: bearer(USER_A) } }),
      server.request('/api/campaigns/f-campaign-b/outreach', { headers: { Authorization: bearer(USER_B) } }),
    ])
    assert.equal(rA.status, 200)
    assert.equal(rB.status, 200)

    const idsA = new Set(rA.body.outreach.map((o: any) => o.id))
    const idsB = new Set(rB.body.outreach.map((o: any) => o.id))

    // No overlap between the two sets
    for (const id of idsA) {
      assert.ok(!idsB.has(id), `Outreach record ${id} appears in both workspace responses`)
    }
    assert.equal(rA.body.total, outreachA.length)
    assert.equal(rB.body.total, outreachB.length)
  })

  it('Multiple concurrent cross-workspace outreach requests all return 403', async () => {
    const requests = [
      // USER_A trying to read WS_B outreach
      server.request('/api/campaigns/f-campaign-b/outreach', { headers: { Authorization: bearer(USER_A) } }),
      server.request('/api/campaigns/f-campaign-b/outreach', { headers: { Authorization: bearer(USER_A) } }),
      // USER_B trying to read WS_A outreach
      server.request('/api/campaigns/f-campaign-a/outreach', { headers: { Authorization: bearer(USER_B) } }),
      server.request('/api/campaigns/f-campaign-a/outreach', { headers: { Authorization: bearer(USER_B) } }),
    ]
    const results = await Promise.all(requests)
    for (const r of results) {
      assert.equal(r.status, 403, 'All cross-workspace outreach requests must be 403')
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// G. Multi-tenant concurrent write stress
// ═══════════════════════════════════════════════════════════════════════════════

describe('G. Multi-tenant concurrent write stress', () => {
  // Track created leads per workspace
  const createdByWorkspace = new Map<string, string[]>()

  let server: TestServer
  let prisma: FakePrisma

  before(async () => {
    createdByWorkspace.set(WS_A, [])
    createdByWorkspace.set(WS_B, [])

    prisma = createFakePrisma({
      user: userLookup,
      membership: strictMembership('owner'),
      workspace: {
        findUnique: async (args: any) => {
          if (args?.where?.id === WS_A) return { id: WS_A, plan: 'growth', subscriptionStatus: 'active' }
          if (args?.where?.id === WS_B) return { id: WS_B, plan: 'growth', subscriptionStatus: 'active' }
          return null
        },
      },
      scoringModel: { findUnique: async () => null },
      lead: {
        create: async (args: any) => {
          const lead = {
            id: `stress-lead-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            ...args?.data,
            stage: 'NEW',
            score: 0,
            email: args?.data?.email ?? null,
            createdAt: new Date(),
            updatedAt: new Date(),
          }
          const wsLeads = createdByWorkspace.get(lead.workspaceId) ?? []
          wsLeads.push(lead.id)
          createdByWorkspace.set(lead.workspaceId, wsLeads)
          return lead
        },
        count: async (args: any) => {
          const wsId = args?.where?.workspaceId
          return (createdByWorkspace.get(wsId) ?? []).length
        },
        findMany: async (args: any) => {
          // For send eligibility checks
          const wsId = args?.where?.workspaceId
          const campaignId = args?.where?.campaignId
          // Return mock eligible leads
          if (campaignId === 'stress-campaign-a') return Array.from({ length: 3 }, (_, i) => makeLead(`el-a-${i}`, WS_A, { email: `a${i}@test.com`, campaignId }))
          if (campaignId === 'stress-campaign-b') return Array.from({ length: 5 }, (_, i) => makeLead(`el-b-${i}`, WS_B, { email: `b${i}@test.com`, campaignId }))
          return (createdByWorkspace.get(wsId) ?? []).map((id) => makeLead(id, wsId ?? ''))
        },
      },
      campaign: {
        findUnique: async (args: any) => {
          if (args?.where?.id === 'stress-campaign-a') return makeCampaign('stress-campaign-a', WS_A, { _count: { leads: 3 } })
          if (args?.where?.id === 'stress-campaign-b') return makeCampaign('stress-campaign-b', WS_B, { _count: { leads: 5 } })
          return null
        },
        create: async (args: any) => ({
          id: `new-c-${Date.now()}-${Math.random()}`,
          ...args?.data,
          createdAt: new Date(),
          updatedAt: new Date(),
          _count: { leads: 0 },
        }),
      },
    })
    installPrisma(prisma)
    server = await startTestServer('/api/leads', leadsRouter)
  })

  after(async () => {
    await server.close()
    resetPrisma()
  })

  it('20 concurrent lead creates split 10/10 — final count is exactly 10 in each workspace', async () => {
    createdByWorkspace.set(WS_A, [])
    createdByWorkspace.set(WS_B, [])

    const requestsA = Array.from({ length: 10 }, (_, i) =>
      server.request('/api/leads', {
        method: 'POST',
        headers: { Authorization: bearer(USER_A), 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: WS_A, businessName: `Alpha Stress Lead ${i + 1}` }),
      })
    )
    const requestsB = Array.from({ length: 10 }, (_, i) =>
      server.request('/api/leads', {
        method: 'POST',
        headers: { Authorization: bearer(USER_B), 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: WS_B, businessName: `Bravo Stress Lead ${i + 1}` }),
      })
    )

    const results = await Promise.all([...requestsA, ...requestsB])
    const successes = results.filter((r) => r.status === 201)
    assert.equal(successes.length, 20, `Expected 20 successful creates, got ${successes.length}`)

    const finalA = createdByWorkspace.get(WS_A) ?? []
    const finalB = createdByWorkspace.get(WS_B) ?? []
    assert.equal(finalA.length, 10, `WS_A should have exactly 10 leads, got ${finalA.length}`)
    assert.equal(finalB.length, 10, `WS_B should have exactly 10 leads, got ${finalB.length}`)

    // No ID cross-contamination
    const setA = new Set(finalA)
    for (const id of finalB) {
      assert.ok(!setA.has(id), `Lead ID ${id} exists in both workspaces`)
    }
  })

  it('All 20 created lead IDs are globally unique across both workspaces', async () => {
    createdByWorkspace.set(WS_A, [])
    createdByWorkspace.set(WS_B, [])

    const all = await Promise.all([
      ...Array.from({ length: 10 }, (_, i) =>
        server.request('/api/leads', {
          method: 'POST',
          headers: { Authorization: bearer(USER_A), 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: WS_A, businessName: `Unique A ${i}` }),
        })
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        server.request('/api/leads', {
          method: 'POST',
          headers: { Authorization: bearer(USER_B), 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: WS_B, businessName: `Unique B ${i}` }),
        })
      ),
    ])

    const ids = all.filter((r) => r.status === 201).map((r) => r.body.lead?.id).filter(Boolean)
    const uniqueIds = new Set(ids)
    assert.equal(uniqueIds.size, ids.length, `Expected ${ids.length} unique IDs, got ${uniqueIds.size} (collision detected)`)
  })

  it('Concurrent eligibility checks for WS_A and WS_B campaign send — each sees only their own leads', async () => {
    // Stand up a separate campaigns server for this sub-test
    const campaignServer = await startTestServer('/api/campaigns', campaignsRouter)
    const eligibleByWorkspace: Record<string, number> = {}

    const eligPrisma = createFakePrisma({
      user: userLookup,
      membership: strictMembership('owner'),
      campaign: {
        findUnique: async (args: any) => {
          if (args?.where?.id === 'stress-campaign-a') return makeCampaign('stress-campaign-a', WS_A, { _count: { leads: 3 } })
          if (args?.where?.id === 'stress-campaign-b') return makeCampaign('stress-campaign-b', WS_B, { _count: { leads: 5 } })
          return null
        },
      },
      lead: {
        count: async (args: any) => {
          const campaignId = args?.where?.campaignId
          const count = campaignId === 'stress-campaign-a' ? 3 : campaignId === 'stress-campaign-b' ? 5 : 0
          eligibleByWorkspace[campaignId] = count
          return count
        },
      },
      outreachSent: { count: async () => 0, findMany: async () => [] },
    })
    installPrisma(eligPrisma)

    const [rA, rB] = await Promise.all([
      campaignServer.request('/api/campaigns/stress-campaign-a/stats', { headers: { Authorization: bearer(USER_A) } }),
      campaignServer.request('/api/campaigns/stress-campaign-b/stats', { headers: { Authorization: bearer(USER_B) } }),
    ])

    await campaignServer.close()
    installPrisma(prisma) // restore G-section prisma for subsequent tests

    assert.equal(rA.status, 200)
    assert.equal(rB.status, 200)
    // Each workspace sees only its own eligible leads
    assert.equal(rA.body.stats.totalLeads, 3, 'WS_A campaign should report 3 leads')
    assert.equal(rB.body.stats.totalLeads, 5, 'WS_B campaign should report 5 leads')
  })

  it('Concurrent cross-workspace write attempts are all blocked (403)', async () => {
    // USER_A trying to create leads in WS_B, USER_B trying to create leads in WS_A
    const badRequests = [
      ...Array.from({ length: 5 }, (_, i) =>
        server.request('/api/leads', {
          method: 'POST',
          headers: { Authorization: bearer(USER_A), 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: WS_B, businessName: `Malicious A ${i}` }),
        })
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        server.request('/api/leads', {
          method: 'POST',
          headers: { Authorization: bearer(USER_B), 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: WS_A, businessName: `Malicious B ${i}` }),
        })
      ),
    ]
    const results = await Promise.all(badRequests)
    for (const r of results) {
      assert.equal(r.status, 403, `Cross-workspace write must be 403, got ${r.status}`)
    }
  })

  it('30 concurrent mixed requests (valid + cross-workspace) — valid ones succeed, cross-workspace ones fail', async () => {
    createdByWorkspace.set(WS_A, [])
    createdByWorkspace.set(WS_B, [])

    const mixed = [
      // 10 valid WS_A creates
      ...Array.from({ length: 10 }, (_, i) =>
        server.request('/api/leads', {
          method: 'POST',
          headers: { Authorization: bearer(USER_A), 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: WS_A, businessName: `Mixed Alpha ${i}` }),
        })
      ),
      // 10 valid WS_B creates
      ...Array.from({ length: 10 }, (_, i) =>
        server.request('/api/leads', {
          method: 'POST',
          headers: { Authorization: bearer(USER_B), 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: WS_B, businessName: `Mixed Bravo ${i}` }),
        })
      ),
      // 10 invalid cross-workspace attempts
      ...Array.from({ length: 5 }, (_, i) =>
        server.request('/api/leads', {
          method: 'POST',
          headers: { Authorization: bearer(USER_A), 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: WS_B, businessName: `Cross A→B ${i}` }),
        })
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        server.request('/api/leads', {
          method: 'POST',
          headers: { Authorization: bearer(USER_B), 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: WS_A, businessName: `Cross B→A ${i}` }),
        })
      ),
    ]

    const results = await Promise.all(mixed)
    const by201 = results.filter((r) => r.status === 201)
    const by403 = results.filter((r) => r.status === 403)

    assert.equal(by201.length, 20, `Expected 20 successful creates, got ${by201.length}`)
    assert.equal(by403.length, 10, `Expected 10 blocked attempts, got ${by403.length}`)

    // Cross-contamination check: no created lead should belong to the wrong workspace
    const idsA = new Set(createdByWorkspace.get(WS_A) ?? [])
    const idsB = new Set(createdByWorkspace.get(WS_B) ?? [])
    for (const id of idsA) {
      assert.ok(!idsB.has(id), `Lead ${id} was inserted into both workspaces`)
    }
  })
})
