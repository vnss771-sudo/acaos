// Integration tests for the /api/prospects router.
//
// Covers workspace authorization on read/write endpoints and the Apollo
// enrichment endpoint, which previously failed with an unhandled
// module-not-found (500) and now returns a clean 503 when the integration is
// not configured.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { prospectsRouter } from '../apps/api/src/routes/prospects.ts'
import {
  createFakePrisma,
  installPrisma,
  resetPrisma,
  startTestServer,
  bearer,
  type FakePrisma,
  type TestServer,
} from './helpers/integration.ts'

const MEMBER = 'u1'
const OWNED_WS = 'ws1'
const OTHER_WS = 'ws2'

function membershipFor(userId: string, workspaceId: string) {
  return userId === MEMBER && workspaceId === OWNED_WS ? { id: 'm1', role: 'admin' } : null
}

function prospectRow(workspaceId: string, id = 'p1') {
  return {
    id,
    workspaceId,
    companyName: 'Acme',
    domain: 'acme.test',
    industry: 'construction',
    employeeCount: 50,
    location: 'NYC',
    contactName: 'C',
    contactEmail: 'c@acme.test',
    contactPhone: null,
    contactTitle: null,
    linkedinUrl: null,
    opportunityScore: 80,
    intentScore: 70,
    fitScore: 75,
    timingScore: 60,
    confidenceScore: 65,
    buyingStage: 'PURCHASING',
    outcomeStage: 'DISCOVERED',
    expectedDealValue: null,
    winProbability: 0.4,
    lastSignalAt: null,
    lastContactedAt: null,
    sourceTag: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    signals: [],
    recommendations: [],
    outcomes: [],
    _count: { signals: 0 },
  }
}

function spec() {
  return {
    user: { findUnique: async () => ({ id: MEMBER, email: 'u1@acme.test', name: null, emailVerified: true }) },
    membership: {
      findFirst: async (args: any) => membershipFor(args?.where?.userId, args?.where?.workspaceId),
    },
    prospect: {
      findMany: async (args: any) => [prospectRow(args?.where?.workspaceId)],
      count: async () => 1,
      findUnique: async (args: any) => {
        if (args?.where?.id === 'p1') return prospectRow(OWNED_WS, 'p1')
        if (args?.where?.id === 'p-other') return prospectRow(OTHER_WS, 'p-other')
        return null
      },
      create: async (args: any) => ({ ...prospectRow(OWNED_WS), ...args.data }),
      update: async (args: any) => ({ ...prospectRow(OWNED_WS), ...args.data }),
      delete: async () => ({ id: 'p1' }),
    },
    workspaceICP: { findUnique: async () => null },
    signal: { findMany: async () => [] },
  }
}

let prisma: FakePrisma
let server: TestServer

beforeEach(async () => {
  delete process.env.APOLLO_API_KEY // ensure enrichment is "not configured"
  prisma = createFakePrisma(spec())
  installPrisma(prisma)
  server = await startTestServer('/api/prospects', prospectsRouter)
})

afterEach(async () => {
  await server.close()
  resetPrisma()
})

const auth = (u: string) => ({ Authorization: bearer(u) })

// --- list / read authz ---

test('GET / denies a workspace the user does not belong to', async () => {
  const res = await server.request(`/api/prospects?workspaceId=${OTHER_WS}`, { headers: auth(MEMBER) })
  assert.equal(res.status, 403)
  assert.equal(prisma.callsTo('prospect', 'findMany').length, 0)
})

test('GET / succeeds for a member', async () => {
  const res = await server.request(`/api/prospects?workspaceId=${OWNED_WS}`, { headers: auth(MEMBER) })
  assert.equal(res.status, 200)
  assert.equal(res.body.prospects.length, 1)
  assert.equal(res.body.prospects[0].tier, 'HOT')
})

test('GET /:id denies access to another workspace\'s prospect', async () => {
  const res = await server.request('/api/prospects/p-other', { headers: auth(MEMBER) })
  assert.equal(res.status, 403)
})

test('GET /:id returns 404 for an unknown prospect', async () => {
  const res = await server.request('/api/prospects/missing', { headers: auth(MEMBER) })
  assert.equal(res.status, 404)
})

// --- write authz ---

test('POST / requires companyName', async () => {
  const res = await server.request('/api/prospects', {
    method: 'POST',
    headers: { ...auth(MEMBER), 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId: OWNED_WS }),
  })
  assert.equal(res.status, 400)
})

test('DELETE /:id denies another workspace and does not delete', async () => {
  const res = await server.request('/api/prospects/p-other', { method: 'DELETE', headers: auth(MEMBER) })
  assert.equal(res.status, 403)
  assert.equal(prisma.callsTo('prospect', 'delete').length, 0)
})

// --- rescore ---

test('POST /:id/rescore recomputes scores for a member', async () => {
  const res = await server.request('/api/prospects/p1/rescore', { method: 'POST', headers: auth(MEMBER) })
  assert.equal(res.status, 200)
  assert.equal(prisma.callsTo('prospect', 'update').length, 1)
})

// --- enrich (Apollo scaffold) ---

test('POST /:id/enrich returns a clean 503 when Apollo is not configured', async () => {
  const res = await server.request('/api/prospects/p1/enrich', { method: 'POST', headers: auth(MEMBER) })
  assert.equal(res.status, 503)
})

test('POST /:id/enrich still enforces workspace access before anything else', async () => {
  const res = await server.request('/api/prospects/p-other/enrich', { method: 'POST', headers: auth(MEMBER) })
  assert.equal(res.status, 403)
})

test('GET /:id/intents returns the prospect bridge intents for a member', async () => {
  const s = spec()
  ;(s as any).outreachIntent = { findMany: async () => [{ id: 'oi1', status: 'PROPOSED', recommendationId: 'r1' }] }
  installPrisma(createFakePrisma(s))
  const res = await server.request('/api/prospects/p1/intents', { headers: auth(MEMBER) })
  assert.equal(res.status, 200)
  assert.equal(res.body.intents[0].status, 'PROPOSED')
})

test('GET /:id/intents denies a prospect in another workspace', async () => {
  const res = await server.request('/api/prospects/p-other/intents', { headers: auth(MEMBER) })
  assert.equal(res.status, 403)
})

test('POST /:id/intents/:intentId/draft denies another workspace', async () => {
  const res = await server.request('/api/prospects/p-other/intents/oi1/draft', { method: 'POST', headers: auth(MEMBER) })
  assert.equal(res.status, 403)
})

test('POST /:id/intents/:intentId/draft 404 when the intent is missing', async () => {
  const s = spec(); (s as any).outreachIntent = { findUnique: async () => null }
  installPrisma(createFakePrisma(s))
  const res = await server.request('/api/prospects/p1/intents/missing/draft', { method: 'POST', headers: auth(MEMBER) })
  assert.equal(res.status, 404)
})

test('POST /:id/intents/:intentId/draft returns 503 when AI is unconfigured', async () => {
  const saved = process.env.OPENAI_API_KEY
  delete process.env.OPENAI_API_KEY
  try {
    const s = spec(); (s as any).outreachIntent = { findUnique: async () => ({ id: 'oi1', prospectId: 'p1', recommendationId: null, messageAngle: 'x' }) }
    installPrisma(createFakePrisma(s))
    const res = await server.request('/api/prospects/p1/intents/oi1/draft', { method: 'POST', headers: auth(MEMBER) })
    assert.equal(res.status, 503)
  } finally {
    if (saved !== undefined) process.env.OPENAI_API_KEY = saved
  }
})

function intentSpec(status: string) {
  const s = spec()
  ;(s as any).outreachIntent = {
    findUnique: async () => ({ id: 'oi1', prospectId: 'p1', workspaceId: OWNED_WS, status }),
    update: async (a: any) => ({ id: 'oi1', prospectId: 'p1', workspaceId: OWNED_WS, status, ...a.data }),
  }
  return s
}

test('POST /:id/intents/:intentId/approve transitions DRAFTED → APPROVED', async () => {
  installPrisma(createFakePrisma(intentSpec('DRAFTED')))
  const res = await server.request('/api/prospects/p1/intents/oi1/approve', { method: 'POST', headers: auth(MEMBER) })
  assert.equal(res.status, 200)
  assert.equal(res.body.status, 'APPROVED')
  assert.equal(res.body.approvedBy, MEMBER)
})

test('POST /:id/intents/:intentId/approve 409 when not yet drafted', async () => {
  installPrisma(createFakePrisma(intentSpec('PROPOSED')))
  const res = await server.request('/api/prospects/p1/intents/oi1/approve', { method: 'POST', headers: auth(MEMBER) })
  assert.equal(res.status, 409)
  assert.match(String(res.body.error), /generate a draft first/)
})

test('POST /:id/intents/:intentId/reject transitions to REJECTED', async () => {
  installPrisma(createFakePrisma(intentSpec('DRAFTED')))
  const res = await server.request('/api/prospects/p1/intents/oi1/reject', { method: 'POST', headers: auth(MEMBER) })
  assert.equal(res.status, 200)
  assert.equal(res.body.status, 'REJECTED')
})

test('POST /:id/intents/:intentId/reject 409 for an already-sent intent', async () => {
  installPrisma(createFakePrisma(intentSpec('SENT')))
  const res = await server.request('/api/prospects/p1/intents/oi1/reject', { method: 'POST', headers: auth(MEMBER) })
  assert.equal(res.status, 409)
})

test('POST /:id/intents/:intentId/approve denies another workspace', async () => {
  const res = await server.request('/api/prospects/p-other/intents/oi1/approve', { method: 'POST', headers: auth(MEMBER) })
  assert.equal(res.status, 403)
})

test('POST /:id/intents/:intentId/approve 404 when the intent is missing', async () => {
  const s = spec(); (s as any).outreachIntent = { findUnique: async () => null }
  installPrisma(createFakePrisma(s))
  const res = await server.request('/api/prospects/p1/intents/missing/approve', { method: 'POST', headers: auth(MEMBER) })
  assert.equal(res.status, 404)
})

test('approve links a valid leadId to the intent (Stage 5)', async () => {
  const s = intentSpec('DRAFTED')
  ;(s as any).lead = { findUnique: async () => ({ workspaceId: OWNED_WS }) }
  installPrisma(createFakePrisma(s))
  const res = await server.request('/api/prospects/p1/intents/oi1/approve', {
    method: 'POST', headers: { Authorization: bearer(MEMBER), 'Content-Type': 'application/json' },
    body: JSON.stringify({ leadId: 'l1' }),
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.leadId, 'l1')
})

test('approve rejects a leadId from another workspace (400)', async () => {
  const s = intentSpec('DRAFTED')
  ;(s as any).lead = { findUnique: async () => ({ workspaceId: OTHER_WS }) }
  installPrisma(createFakePrisma(s))
  const res = await server.request('/api/prospects/p1/intents/oi1/approve', {
    method: 'POST', headers: { Authorization: bearer(MEMBER), 'Content-Type': 'application/json' },
    body: JSON.stringify({ leadId: 'l-other' }),
  })
  assert.equal(res.status, 400)
})

test('POST /:id/intents/:intentId/materialize 409 when intent not approved', async () => {
  installPrisma(createFakePrisma(intentSpec('DRAFTED')))
  const res = await server.request('/api/prospects/p1/intents/oi1/materialize', { method: 'POST', headers: auth(MEMBER) })
  assert.equal(res.status, 409)
})

test('POST /:id/intents/:intentId/materialize 400 when prospect has no contact email', async () => {
  const s = intentSpec('APPROVED')
  ;(s as any).outreachIntent.findUnique = async () => ({ id: 'oi1', prospectId: 'p1', workspaceId: OWNED_WS, status: 'APPROVED', draftSubject: 'S', draftBody: 'B', draftFollowup: null, leadId: null })
  ;(s as any).prospect = { findUnique: async () => ({ id: 'p1', workspaceId: OWNED_WS, companyName: 'X', contactEmail: null, contactName: null, domain: null, location: null, industry: null }) }
  installPrisma(createFakePrisma(s))
  const res = await server.request('/api/prospects/p1/intents/oi1/materialize', { method: 'POST', headers: auth(MEMBER) })
  assert.equal(res.status, 400)
})

test('POST /:id/intents/:intentId/materialize 201 materialises an approved intent', async () => {
  const s = intentSpec('APPROVED')
  ;(s as any).outreachIntent.findUnique = async () => ({ id: 'oi1', prospectId: 'p1', workspaceId: OWNED_WS, status: 'APPROVED', draftSubject: 'S', draftBody: 'B', draftFollowup: null, leadId: null })
  ;(s as any).outreachIntent.update = async (a: any) => ({ id: 'oi1', ...a.data })
  ;(s as any).prospect = { findUnique: async () => ({ id: 'p1', workspaceId: OWNED_WS, companyName: 'Acme', contactEmail: 'c@acme.test', contactName: 'C', domain: 'acme.test', location: 'Bne', industry: 'Plumbing' }) }
  ;(s as any).campaign = { findFirst: async () => null, create: async () => ({ id: 'camp1' }) }
  ;(s as any).lead = { findFirst: async () => null, create: async () => ({ id: 'lead1' }) }
  ;(s as any).outreachDraft = { create: async () => ({ id: 'draft1' }) }
  installPrisma(createFakePrisma(s))
  const res = await server.request('/api/prospects/p1/intents/oi1/materialize', { method: 'POST', headers: auth(MEMBER) })
  assert.equal(res.status, 201)
  assert.equal(res.body.leadId, 'lead1')
  assert.equal(res.body.campaignId, 'camp1')
})

const verifiedUserPS = { findUnique: async () => ({ id: MEMBER, email: 'u1@acme.test', name: null, emailVerified: true }) }
function importSignalsSpec() {
  const s = spec()
  ;(s as any).user = verifiedUserPS
  ;(s as any).prospect = { findFirst: async () => null, create: async () => ({ id: 'np1' }) }
  ;(s as any).evidenceSource = { create: async () => ({ id: 'ev1' }) }
  ;(s as any).signal = { upsert: async (a: any) => ({ id: 'sig1', ...a.create }) }
  return s
}
const jsonHeaders = { Authorization: bearer(MEMBER), 'Content-Type': 'application/json' }

// The live-enqueue happy-path (a successful ingest triggers scoreProspects →
// Redis) is integration territory — it would leave an open Redis handle and hang
// the fast runner, matching the repo convention in routes-jobs.test.ts. The
// successful ingest path is covered by the golden DB test (real Postgres).
test('POST /import-signals rejects rows missing evidence or with a bad signal type', async () => {
  installPrisma(createFakePrisma(importSignalsSpec()))
  const res = await server.request('/api/prospects/import-signals', {
    method: 'POST', headers: jsonHeaders,
    body: JSON.stringify({ workspaceId: OWNED_WS, rows: [
      { companyName: 'NoEvidence Co', signalType: 'HIRING' },
      { companyName: 'BadType Co', signalType: 'NONSENSE', provider: 'x', sourceType: 'y' },
    ] }),
  })
  assert.equal(res.status, 201)
  assert.equal(res.body.signalsIngested, 0)
  assert.equal(res.body.failed, 2)
})

test('POST /import-signals denies a non-member workspace', async () => {
  installPrisma(createFakePrisma(importSignalsSpec()))
  const res = await server.request('/api/prospects/import-signals', {
    method: 'POST', headers: jsonHeaders,
    body: JSON.stringify({ workspaceId: OTHER_WS, rows: [{ companyName: 'X', signalType: 'HIRING', provider: 'p', sourceType: 't' }] }),
  })
  assert.equal(res.status, 403)
})

test('POST /import-signals 400 without rows', async () => {
  installPrisma(createFakePrisma(importSignalsSpec()))
  const res = await server.request('/api/prospects/import-signals', {
    method: 'POST', headers: jsonHeaders, body: JSON.stringify({ workspaceId: OWNED_WS }),
  })
  assert.equal(res.status, 400)
})

test('GET /intents returns workspace actionable intents sorted by opportunity score', async () => {
  const s = spec()
  ;(s as any).outreachIntent = { findMany: async () => [
    { id: 'i1', status: 'PROPOSED', prospect: { opportunityScore: 50, companyName: 'Low' } },
    { id: 'i2', status: 'APPROVED', prospect: { opportunityScore: 90, companyName: 'High' } },
  ] }
  installPrisma(createFakePrisma(s))
  const res = await server.request(`/api/prospects/intents?workspaceId=${OWNED_WS}`, { headers: auth(MEMBER) })
  assert.equal(res.status, 200)
  assert.equal(res.body.intents[0].prospect.companyName, 'High')
})

test('GET /intents 400 without workspaceId, 403 for a non-member workspace', async () => {
  installPrisma(createFakePrisma(spec()))
  assert.equal((await server.request('/api/prospects/intents', { headers: auth(MEMBER) })).status, 400)
  assert.equal((await server.request(`/api/prospects/intents?workspaceId=${OTHER_WS}`, { headers: auth(MEMBER) })).status, 403)
})

// --- discover (mission-scoped) ---

function discoverSpec(missionWorkspaceId: string | null) {
  const s = spec()
  ;(s as any).user = verifiedUserPS
  ;(s as any).mission = {
    findUnique: async () => (missionWorkspaceId ? { workspaceId: missionWorkspaceId, playbookId: null } : null),
  }
  return s
}

test('POST /discover rejects a body violating the shared contract (400)', async () => {
  installPrisma(createFakePrisma(discoverSpec(OWNED_WS)))
  // Missing workspaceId — zod validation fails before any work.
  const res = await server.request('/api/prospects/discover', {
    method: 'POST', headers: jsonHeaders, body: JSON.stringify({ source: 'apollo' }),
  })
  assert.equal(res.status, 400)
})

test('POST /discover rejects a missionId outside the workspace (404)', async () => {
  installPrisma(createFakePrisma(discoverSpec(OTHER_WS)))
  const res = await server.request('/api/prospects/discover', {
    method: 'POST', headers: jsonHeaders, body: JSON.stringify({ workspaceId: OWNED_WS, missionId: 'm-other' }),
  })
  assert.equal(res.status, 404)
})

test('POST /discover accepts a valid mission then 503 when no source is configured', async () => {
  delete process.env.APOLLO_API_KEY
  installPrisma(createFakePrisma(discoverSpec(OWNED_WS)))
  const res = await server.request('/api/prospects/discover', {
    method: 'POST', headers: jsonHeaders, body: JSON.stringify({ workspaceId: OWNED_WS, missionId: 'm1' }),
  })
  assert.equal(res.status, 503)
})
