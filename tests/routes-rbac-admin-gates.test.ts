// RBAC regression net: high-risk endpoints (bulk import/export, destructive
// deletes, campaign/mission control plane, discovery/enrichment that spends
// provider quota, manual signals, bulk AI) must require at least the `admin`
// role. A workspace `member` is denied (403); an `admin` clears the gate.
//
// One server mounts every router under /api so a single fake Prisma drives the
// whole matrix. The fake returns each entity in the owned workspace so the
// per-handler entity lookup passes and execution reaches the role gate.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { Router } from 'express'
import { campaignsRouter } from '../apps/api/src/routes/campaigns.ts'
import { leadsRouter } from '../apps/api/src/routes/leads.ts'
import { prospectsRouter } from '../apps/api/src/routes/prospects.ts'
import { missionsRouter } from '../apps/api/src/routes/missions.ts'
import { packsRouter } from '../apps/api/src/routes/packs.ts'
import { signalsRouter } from '../apps/api/src/routes/signals.ts'
import { jobsRouter } from '../apps/api/src/routes/jobs.ts'
import {
  createFakePrisma, installPrisma, resetPrisma, startTestServer, bearer,
  type FakePrisma, type TestServer,
} from './helpers/integration.ts'

const USER = 'u1'
const WS = 'ws1'

// Build the fake with a fixed caller role. Every entity lives in WS so the
// handler's existence check passes and control reaches the role gate.
function specForRole(role: 'member' | 'admin') {
  return {
    user: { findUnique: async () => ({ id: USER, email: 'u1@a.test', name: null, emailVerified: true }) },
    membership: { findFirst: async (a: any) => {
      // assertMinimumWorkspaceRole selects { role }; only the owned ws matches.
      return a?.where?.workspaceId === WS && a?.where?.userId === USER ? { role } : null
    } },
    campaign: { findUnique: async () => ({ id: 'c1', workspaceId: WS, _count: { leads: 0 } }) },
    lead:     { findUnique: async () => ({ id: 'l1', workspaceId: WS }), findMany: async () => [] },
    prospect: { findUnique: async () => ({ id: 'p1', workspaceId: WS }) },
    signal:   { findUnique: async () => ({ id: 'sig1', workspaceId: WS }) },
    mission:  { findUnique: async () => ({ id: 'm1', workspaceId: WS, playbookId: null, campaign: null }) },
    outreachDraft: { findUnique: async () => ({ id: 'd1', workspaceId: WS, leadId: 'l1' }) },
  }
}

function mountAll(): Router {
  const api = Router()
  api.use('/campaigns', campaignsRouter)
  api.use('/leads', leadsRouter)
  api.use('/prospects', prospectsRouter)
  api.use('/missions', missionsRouter)
  api.use('/packs', packsRouter)
  api.use('/signals', signalsRouter)
  api.use('/jobs', jobsRouter)
  return api
}

let server: TestServer
beforeEach(async () => { server = await startTestServer('/api', mountAll()) })
afterEach(async () => { await server.close(); resetPrisma() })

const headers = { Authorization: bearer(USER), 'Content-Type': 'application/json' }
const json = (b: unknown) => ({ method: 'POST', headers, body: JSON.stringify(b) })

// Every gated endpoint, with a request shaped to clear validation/existence
// checks and reach the role gate. method defaults to the verb in the tuple.
const GATED: Array<{ name: string; method: string; path: string; body?: unknown }> = [
  { name: 'campaigns create',        method: 'POST',   path: '/api/campaigns', body: { workspaceId: WS, name: 'C', goalType: 'BOOK_CALL' } },
  { name: 'campaigns update',        method: 'PATCH',  path: '/api/campaigns/c1', body: { name: 'X' } },
  { name: 'campaigns send',          method: 'POST',   path: '/api/campaigns/c1/send', body: {} },
  { name: 'campaigns delete',        method: 'DELETE', path: '/api/campaigns/c1' },
  { name: 'campaigns retry-failed',  method: 'POST',   path: '/api/campaigns/c1/retry-failed', body: {} },
  { name: 'leads import',            method: 'POST',   path: '/api/leads/import', body: { workspaceId: WS, leads: [{ businessName: 'A' }] } },
  { name: 'leads export',            method: 'GET',    path: `/api/leads/export?workspaceId=${WS}` },
  { name: 'leads delete',            method: 'DELETE', path: '/api/leads/l1' },
  { name: 'leads bulk-delete',       method: 'POST',   path: '/api/leads/bulk-delete', body: { workspaceId: WS, ids: ['l1'] } },
  { name: 'leads bulk-stage',        method: 'POST',   path: '/api/leads/bulk-stage', body: { workspaceId: WS, ids: ['l1'], stage: 'NEW' } },
  { name: 'leads bulk-assign',       method: 'POST',   path: '/api/leads/bulk-assign', body: { workspaceId: WS, ids: ['l1'], campaignId: 'c1' } },
  { name: 'leads draft approve',     method: 'POST',   path: '/api/leads/l1/drafts/d1/approve', body: {} },
  { name: 'leads draft reject',      method: 'POST',   path: '/api/leads/l1/drafts/d1/reject', body: {} },
  { name: 'leads draft edit',        method: 'PATCH',  path: '/api/leads/l1/drafts/d1', body: { subject: 'S' } },
  { name: 'prospects export',        method: 'GET',    path: `/api/prospects/export?workspaceId=${WS}` },
  { name: 'prospects discover',      method: 'POST',   path: '/api/prospects/discover', body: { workspaceId: WS } },
  { name: 'prospects import',        method: 'POST',   path: '/api/prospects/import', body: { workspaceId: WS, rows: [{ companyName: 'A' }] } },
  { name: 'prospects import-signals',method: 'POST',   path: '/api/prospects/import-signals', body: { workspaceId: WS, rows: [{ companyName: 'A' }] } },
  { name: 'prospects create',        method: 'POST',   path: '/api/prospects', body: { workspaceId: WS, companyName: 'A' } },
  { name: 'prospects delete',        method: 'DELETE', path: '/api/prospects/p1' },
  { name: 'prospects enrich',        method: 'POST',   path: '/api/prospects/p1/enrich', body: {} },
  { name: 'prospects intent draft',  method: 'POST',   path: '/api/prospects/p1/intents/oi1/draft', body: {} },
  { name: 'prospects intent approve',method: 'POST',   path: '/api/prospects/p1/intents/oi1/approve', body: {} },
  { name: 'prospects intent reject', method: 'POST',   path: '/api/prospects/p1/intents/oi1/reject', body: {} },
  { name: 'prospects intent matrlz', method: 'POST',   path: '/api/prospects/p1/intents/oi1/materialize', body: {} },
  { name: 'missions create',         method: 'POST',   path: '/api/missions', body: { workspaceId: WS, name: 'M' } },
  { name: 'missions update',         method: 'PATCH',  path: '/api/missions/m1', body: { status: 'PAUSED' } },
  { name: 'packs apply',             method: 'POST',   path: '/api/packs/fieldops/apply', body: { workspaceId: WS } },
  { name: 'signals create',          method: 'POST',   path: '/api/signals', body: { workspaceId: WS, prospectId: 'p1', type: 'HIRING', strength: 50 } },
  { name: 'signals delete',          method: 'DELETE', path: '/api/signals/sig1' },
  { name: 'jobs research-bulk',      method: 'POST',   path: '/api/jobs/research-bulk', body: { workspaceId: WS } },
]

for (const ep of GATED) {
  test(`member is denied: ${ep.name}`, async () => {
    installPrisma(createFakePrisma(specForRole('member')) as FakePrisma)
    const init: RequestInit = { method: ep.method, headers }
    if (ep.body !== undefined) init.body = JSON.stringify(ep.body)
    const res = await server.request(ep.path, init)
    assert.equal(res.status, 403, `${ep.name} should 403 for a member, got ${res.status}`)
  })
}

// Positive controls: an admin clears the gate (the request then fails for an
// unrelated reason — never 403). Proves the gate keys on role, not membership.
test('admin clears the gate — packs apply reaches pack lookup (404, not 403)', async () => {
  installPrisma(createFakePrisma(specForRole('admin')) as FakePrisma)
  const res = await server.request('/api/packs/does-not-exist/apply', json({ workspaceId: WS }))
  assert.equal(res.status, 404)
})

test('admin clears the gate — discover reaches the source check (not 403)', async () => {
  delete process.env.APOLLO_API_KEY
  installPrisma(createFakePrisma(specForRole('admin')) as FakePrisma)
  const res = await server.request('/api/prospects/discover', json({ workspaceId: WS }))
  assert.notEqual(res.status, 403)
})
