// Integration tests for /api/stats — dashboard funnel and campaign stats,
// both workspace-scoped.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { statsRouter } from '../apps/api/src/routes/stats.ts'
import {
  createFakePrisma, installPrisma, resetPrisma, startTestServer, bearer,
  type FakePrisma, type TestServer,
} from './helpers/integration.ts'

const USER = 'u1'
const OWNED = 'ws1'
const OTHER = 'ws2'
const member = (uid: string, wid: string) => (uid === USER && wid === OWNED ? { id: 'm1' } : null)

function spec() {
  return {
    user: { findUnique: async () => ({ id: USER, email: 'u1@a.test', name: null, emailVerified: true }) },
    membership: { findFirst: async (a: any) => member(a?.where?.userId, a?.where?.workspaceId) },
    lead: {
      groupBy: async (a: any) => a?.by?.[0] === 'stage'
        ? [{ stage: 'OUTREACH_SENT', _count: { _all: 4 } }, { stage: 'REPLIED', _count: { _all: 2 } }, { stage: 'BOOKED', _count: { _all: 1 } }]
        : [{ score: 80, _count: { _all: 2 } }, { score: 30, _count: { _all: 1 } }],
      count: async () => 7,
      findMany: async () => [{ id: 'l1', businessName: 'Acme', stage: 'NEW', score: 80, category: 'x' }],
    },
    campaign: {
      count: async () => 1,
      findMany: async () => [{
        id: 'c1', name: 'C', goalType: 'BOOK_CALL', createdAt: new Date(),
        _count: { leads: 5 },
        leads: [{ stage: 'REPLIED', score: 70 }, { stage: 'OUTREACH_SENT', score: 40 }],
      }],
    },
    scoringModel: { findUnique: async () => ({ weights: {}, performanceMetrics: {}, updateCount: 3, lastWeightUpdate: new Date() }) },
    usageRecord: { findMany: async () => [{ action: 'AI_RESEARCH', count: 2 }] },
    workspace: { findUnique: async () => ({ plan: 'free', subscriptionStatus: null }) },
    discoveryRun: { groupBy: async () => [] },
    // For GET /reputation: 100 sends, 8 bounces (8% > 5% default) → unhealthy.
    contactEvent: { count: async (a: any) => (a?.where?.type === 'BOUNCED' ? 8 : a?.where?.type === 'SENT' ? 100 : 0) },
    unsubscribeEvent: { count: async () => 0 },
    // For GET /ai-prompts: one prompt version with 3 approved / 1 rejected.
    outreachDraft: {
      groupBy: async () => [
        { promptVersionId: 'pv1', status: 'APPROVED', _count: { _all: 3 } },
        { promptVersionId: 'pv1', status: 'REJECTED', _count: { _all: 1 } },
      ],
    },
    aiPromptVersion: {
      findMany: async () => [{ id: 'pv1', type: 'OUTREACH', version: 1, model: 'gpt-4o-mini', createdAt: new Date() }],
    },
  }
}

let prisma: FakePrisma
let server: TestServer
beforeEach(async () => { prisma = createFakePrisma(spec()); installPrisma(prisma); server = await startTestServer('/api/stats', statsRouter) })
afterEach(async () => { await server.close(); resetPrisma() })
const auth = (u = USER) => ({ Authorization: bearer(u) })

test('GET / requires workspaceId', async () => {
  assert.equal((await server.request('/api/stats', { headers: auth() })).status, 400)
})
test('GET / denies a non-member workspace', async () => {
  assert.equal((await server.request(`/api/stats?workspaceId=${OTHER}`, { headers: auth() })).status, 403)
})
test('GET / returns a funnel with computed conversion metrics', async () => {
  const res = await server.request(`/api/stats?workspaceId=${OWNED}`, { headers: auth() })
  assert.equal(res.status, 200)
  // contacted = OUTREACH_SENT+REPLIED+BOOKED = 7; replied = REPLIED+BOOKED = 3
  assert.equal(res.body.metrics.contacted, 7)
  assert.equal(res.body.metrics.replied, 3)
  assert.equal(res.body.scoreDistribution.HOT, 2) // score 80 → HOT
})
test('GET / derives totalLeads from the stage funnel and surfaces the lead cap', async () => {
  const res = await server.request(`/api/stats?workspaceId=${OWNED}`, { headers: auth() })
  assert.equal(res.status, 200)
  // 4 + 2 + 1 across the stage groupBy — no separate lead.count round-trip.
  assert.equal(res.body.totalLeads, 7)
  // maxLeads now flows from the (lapse-aware) usage data: free plan = 500.
  assert.equal(res.body.usage.maxLeads, 500)
  assert.equal(res.body.usage.leads.used, 7)
})

test('GET / coalesces a concurrent burst into one aggregation, then serves the TTL cache', async () => {
  // Count the by-stage aggregation so we can prove the fan-out runs once for the
  // whole burst (single-flight) and again-within-TTL is served from cache.
  let stageGroupBys = 0
  const s = spec() as any
  const baseGroupBy = s.lead.groupBy
  s.lead.groupBy = async (a: any) => { if (a?.by?.[0] === 'stage') stageGroupBys++; return baseGroupBy(a) }
  installPrisma(createFakePrisma(s)) // also clears any prior cache entry

  const burst = await Promise.all(
    Array.from({ length: 25 }, () => server.request(`/api/stats?workspaceId=${OWNED}`, { headers: auth() })),
  )
  for (const r of burst) assert.equal(r.status, 200)
  assert.equal(stageGroupBys, 1, 'one aggregation for the concurrent burst')

  const again = await server.request(`/api/stats?workspaceId=${OWNED}`, { headers: auth() })
  assert.equal(again.status, 200)
  assert.equal(again.body.totalLeads, 7)
  assert.equal(stageGroupBys, 1, 'follow-up within TTL served from cache')
})

test('GET /activation denies a non-member workspace', async () => {
  assert.equal((await server.request(`/api/stats/activation?workspaceId=${OTHER}`, { headers: auth() })).status, 403)
})
test('GET /activation returns the workspace activation progress + next step', async () => {
  const s = spec()
  // Signed up + ICP configured; not yet sent or replied.
  const done = new Set(['signup', 'icp.configured'])
  s.analyticsEvent = { findFirst: async (a: any) => (done.has(a.where.name) ? { occurredAt: new Date('2026-06-01T00:00:00Z') } : null) } as any
  installPrisma(createFakePrisma(s))
  const res = await server.request(`/api/stats/activation?workspaceId=${OWNED}`, { headers: auth() })
  assert.equal(res.status, 200)
  assert.equal(res.body.completedCount, 2)
  assert.equal(res.body.nextStep, 'campaign.sent')
})

test('GET /campaigns denies a non-member workspace', async () => {
  assert.equal((await server.request(`/api/stats/campaigns?workspaceId=${OTHER}`, { headers: auth() })).status, 403)
})
test('GET /campaigns aggregates per-campaign stats', async () => {
  const res = await server.request(`/api/stats/campaigns?workspaceId=${OWNED}`, { headers: auth() })
  assert.equal(res.status, 200)
  assert.equal(res.body.campaigns[0].totalLeads, 5)
  assert.equal(res.body.campaigns[0].activeLeads, 1) // one REPLIED
})

test('GET /reputation denies a non-member workspace', async () => {
  assert.equal((await server.request(`/api/stats/reputation?workspaceId=${OTHER}`, { headers: auth() })).status, 403)
})
test('GET /reputation returns the trailing rates, verdict, and guard mode', async () => {
  const res = await server.request(`/api/stats/reputation?workspaceId=${OWNED}`, { headers: auth() })
  assert.equal(res.status, 200)
  assert.equal(res.body.totalSends, 100)
  assert.equal(res.body.bounces, 8)
  assert.equal(res.body.bounceRate, 0.08)
  assert.equal(res.body.healthy, false)
  assert.equal(res.body.reason, 'BOUNCE_RATE_HIGH')
  assert.ok(['off', 'observe', 'enforce'].includes(res.body.guardMode))
})

test('GET /ai-prompts denies a non-member workspace', async () => {
  assert.equal((await server.request(`/api/stats/ai-prompts?workspaceId=${OTHER}`, { headers: auth() })).status, 403)
})
test('GET /ai-prompts returns per-prompt-version draft-quality rates', async () => {
  const res = await server.request(`/api/stats/ai-prompts?workspaceId=${OWNED}`, { headers: auth() })
  assert.equal(res.status, 200)
  assert.equal(res.body.promptVersions.length, 1)
  const pv = res.body.promptVersions[0]
  assert.equal(pv.version, 1)
  assert.equal(pv.model, 'gpt-4o-mini')
  assert.equal(pv.approvalRate, 0.75) // 3 approved / 4 reviewed
  assert.equal(pv.rejectionRate, 0.25)
})
