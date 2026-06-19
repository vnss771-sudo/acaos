/**
 * Security & IDOR isolation tests.
 *
 * Every workspace-scoped endpoint must enforce that the authenticated user
 * belongs to the workspace they're operating on. These tests confirm that
 * a user from workspace A cannot read, modify, or delete resources owned by
 * workspace B — even when they supply a valid JWT.
 *
 * Additionally covers JWT attack vectors not in middleware-auth.test.ts:
 * algorithm confusion, none-algorithm, role escalation via payload tampering.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  createFakePrisma, installPrisma, resetPrisma,
  startTestServer, bearer,
  type FakePrisma, type TestServer
} from './helpers/integration.ts'
import { leadsRouter } from '../apps/api/src/routes/leads.ts'
import { campaignsRouter } from '../apps/api/src/routes/campaigns.ts'
import { workspaceRouter } from '../apps/api/src/routes/workspaces.ts'
import { signJwt } from '../packages/backend-core/src/lib/jwt.ts'

// ── env ────────────────────────────────────────────────────────────────────────
process.env.JWT_SECRET = 'test-security-isolation-secret-32ch'
process.env.NODE_ENV = 'test'

const USER_A = 'user-alpha-001'
const USER_B = 'user-bravo-002'
const WS_A = 'workspace-alpha'
const WS_B = 'workspace-bravo'
const LEAD_IN_B = 'lead-in-ws-b'
const CAMPAIGN_IN_B = 'campaign-in-ws-b'

function membershipFor(userId: string, workspaceId: string) {
  return { id: `m-${userId}-${workspaceId}`, userId, workspaceId, role: 'member' }
}

// Auth middleware always calls user.findUnique({ where: { id } }).
// Every fake Prisma spec must include this, otherwise the middleware throws 500.
const userLookup = {
  findUnique: async (args: any) => {
    const db: Record<string, object> = {
      [USER_A]: { id: USER_A, email: 'a@test.com', name: null },
      [USER_B]: { id: USER_B, email: 'b@test.com', name: null },
    }
    return db[args?.where?.id] ?? null
  }
}

// ── JWT attack helpers ─────────────────────────────────────────────────────────

function makeAlgNoneToken(userId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ userId, iat: Date.now() })).toString('base64url')
  return `${header}.${payload}.`
}

function makeHs384Token(userId: string): string {
  // Fabricate a token with HS384 alg header but same payload — verify must reject
  const header = Buffer.from(JSON.stringify({ alg: 'HS384', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ userId, iat: Date.now() })).toString('base64url')
  const sig = Buffer.from('forgedsignature').toString('base64url')
  return `${header}.${payload}.${sig}`
}

function makeRoleEscalationToken(): string {
  // Legit JWT but with role injected into payload — backend must ignore it
  const legit = signJwt({ userId: USER_A })
  const [h, p, s] = legit.split('.')
  const decodedPayload = JSON.parse(Buffer.from(p, 'base64url').toString())
  const escalated = Buffer.from(JSON.stringify({ ...decodedPayload, role: 'owner', plan: 'growth' })).toString('base64url')
  return `${h}.${escalated}.${s}` // signature now invalid
}

// ── Workspace isolation: leads ─────────────────────────────────────────────────

describe('IDOR: leads', () => {
  let prisma: FakePrisma
  let server: TestServer

  const leadInB = {
    id: LEAD_IN_B, workspaceId: WS_B, businessName: 'Evil Corp',
    score: 99, stage: 'NEW', createdAt: new Date(), updatedAt: new Date()
  }

  before(async () => {
    prisma = createFakePrisma({
      user: userLookup,
      membership: {
        findFirst: async (args: any) => {
          // User A is only a member of WS_A, not WS_B
          const { userId, workspaceId } = args?.where ?? {}
          return userId === USER_A && workspaceId === WS_A ? membershipFor(USER_A, WS_A) : null
        }
      },
      lead: {
        findUnique: async (args: any) => args?.where?.id === LEAD_IN_B ? leadInB : null,
        findMany: async () => [leadInB],
        count: async () => 0,
        update: async (args: any) => ({ ...leadInB, ...args?.data }),
        delete: async () => ({ id: LEAD_IN_B })
      },
      workspace: {
        findUnique: async () => ({ id: WS_B, plan: 'free', subscriptionStatus: null })
      }
    })
    installPrisma(prisma)
    server = await startTestServer('/api/leads', leadsRouter)
  })

  after(async () => { await server.close(); resetPrisma() })

  it('GET /api/leads — user A cannot list leads in workspace B', async () => {
    const r = await server.request('/api/leads?workspaceId=' + WS_B, {
      headers: { Authorization: bearer(USER_A) }
    })
    assert.equal(r.status, 403, `Expected 403 got ${r.status}: ${JSON.stringify(r.body)}`)
  })

  it('GET /api/leads/:id — user A cannot read a lead owned by workspace B', async () => {
    const r = await server.request('/api/leads/' + LEAD_IN_B, {
      headers: { Authorization: bearer(USER_A) }
    })
    assert.equal(r.status, 403)
  })

  it('PATCH /api/leads/:id — user A cannot update a lead in workspace B', async () => {
    const r = await server.request('/api/leads/' + LEAD_IN_B, {
      method: 'PATCH',
      headers: { Authorization: bearer(USER_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage: 'DEAD', score: 0 })
    })
    assert.equal(r.status, 403)
    const updates = prisma.callsTo('lead', 'update')
    assert.equal(updates.length, 0, 'lead.update must never be called')
  })

  it('DELETE /api/leads/:id — user A cannot delete a lead in workspace B', async () => {
    const r = await server.request('/api/leads/' + LEAD_IN_B, {
      method: 'DELETE',
      headers: { Authorization: bearer(USER_A) }
    })
    assert.equal(r.status, 403)
    assert.equal(prisma.callsTo('lead', 'delete').length, 0, 'lead.delete must never be called')
  })
})

// ── Workspace isolation: campaigns ─────────────────────────────────────────────

describe('IDOR: campaigns', () => {
  let prisma: FakePrisma
  let server: TestServer

  const campaignInB = {
    id: CAMPAIGN_IN_B, workspaceId: WS_B, name: 'B Campaign', goalType: 'BOOK_CALL',
    createdAt: new Date(), updatedAt: new Date(), _count: { leads: 0 }
  }

  before(async () => {
    prisma = createFakePrisma({
      user: userLookup,
      membership: {
        findFirst: async (args: any) => {
          const { userId, workspaceId } = args?.where ?? {}
          return userId === USER_A && workspaceId === WS_A ? membershipFor(USER_A, WS_A) : null
        }
      },
      campaign: {
        findUnique: async (args: any) => args?.where?.id === CAMPAIGN_IN_B ? campaignInB : null,
        update: async (args: any) => ({ ...campaignInB, ...args?.data }),
        delete: async () => ({})
      }
    })
    installPrisma(prisma)
    server = await startTestServer('/api/campaigns', campaignsRouter)
  })

  after(async () => { await server.close(); resetPrisma() })

  it('PATCH campaign in B — user A gets 403', async () => {
    const r = await server.request('/api/campaigns/' + CAMPAIGN_IN_B, {
      method: 'PATCH',
      headers: { Authorization: bearer(USER_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Hijacked' })
    })
    assert.equal(r.status, 403)
    assert.equal(prisma.callsTo('campaign', 'update').length, 0)
  })

  it('DELETE campaign in B — user A gets 403', async () => {
    const r = await server.request('/api/campaigns/' + CAMPAIGN_IN_B, {
      method: 'DELETE',
      headers: { Authorization: bearer(USER_A) }
    })
    assert.equal(r.status, 403)
    assert.equal(prisma.callsTo('campaign', 'delete').length, 0)
  })
})

// ── Workspace isolation: workspace settings ────────────────────────────────────

describe('IDOR: workspace settings', () => {
  let prisma: FakePrisma
  let server: TestServer

  before(async () => {
    prisma = createFakePrisma({
      user: userLookup,
      membership: {
        findFirst: async (args: any) => {
          const { userId, workspaceId } = args?.where ?? {}
          if (userId === USER_A && workspaceId === WS_A) return membershipFor(USER_A, WS_A)
          return null
        },
        findMany: async () => []
      },
      workspace: {
        findUnique: async (args: any) =>
          args?.where?.id === WS_B ? { id: WS_B, name: 'B Space', slug: 'b-space', plan: 'free' } : null,
        update: async (args: any) => ({ id: args?.where?.id }),
        findMany: async () => []
      }
    })
    installPrisma(prisma)
    server = await startTestServer('/api/workspaces', workspaceRouter)
  })

  after(async () => { await server.close(); resetPrisma() })

  it('GET /api/workspaces/:id — user A cannot view workspace B', async () => {
    const r = await server.request('/api/workspaces/' + WS_B, {
      headers: { Authorization: bearer(USER_A) }
    })
    assert.equal(r.status, 403)
  })

  it('PATCH /api/workspaces/:id — user A cannot rename workspace B', async () => {
    const r = await server.request('/api/workspaces/' + WS_B, {
      method: 'PATCH',
      headers: { Authorization: bearer(USER_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Hijacked' })
    })
    assert.equal(r.status, 403)
    assert.equal(prisma.callsTo('workspace', 'update').length, 0)
  })

  it('POST /api/workspaces/:id/members — member (not owner) cannot add team members', async () => {
    // USER_B is a plain member of WS_B — should not be able to add members
    const memberBSpec = createFakePrisma({
      membership: {
        findFirst: async (args: any) => {
          const { userId, workspaceId, role } = args?.where ?? {}
          if (userId === USER_B && workspaceId === WS_B) {
            const m = membershipFor(USER_B, WS_B)
            if (role?.in && !role.in.includes(m.role)) return null
            return m
          }
          return null
        },
        create: async () => ({})
      },
      user: { findUnique: async () => ({ id: USER_A, email: 'a@test.com', name: 'A' }) }
    })
    installPrisma(memberBSpec)
    const r = await server.request('/api/workspaces/' + WS_B + '/members', {
      method: 'POST',
      headers: { Authorization: bearer(USER_B), 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'victim@example.com' })
    })
    assert.equal(r.status, 403)
  })
})

// ── JWT algorithm confusion / forgery ─────────────────────────────────────────

describe('JWT attack vectors', () => {
  let prisma: FakePrisma
  let server: TestServer

  before(async () => {
    prisma = createFakePrisma({
      user: userLookup,
      membership: {
        findFirst: async () => membershipFor(USER_A, WS_A)
      },
      lead: { findMany: async () => [], count: async () => 0 }
    })
    installPrisma(prisma)
    server = await startTestServer('/api/leads', leadsRouter)
  })

  after(async () => { await server.close(); resetPrisma() })

  it('alg:none token is rejected', async () => {
    const r = await server.request('/api/leads?workspaceId=' + WS_A, {
      headers: { Authorization: `Bearer ${makeAlgNoneToken(USER_A)}` }
    })
    assert.equal(r.status, 401)
  })

  it('HS384 alg-confusion token is rejected', async () => {
    const r = await server.request('/api/leads?workspaceId=' + WS_A, {
      headers: { Authorization: `Bearer ${makeHs384Token(USER_A)}` }
    })
    assert.equal(r.status, 401)
  })

  it('role-escalation tampered payload is rejected (signature mismatch)', async () => {
    const r = await server.request('/api/leads?workspaceId=' + WS_A, {
      headers: { Authorization: `Bearer ${makeRoleEscalationToken()}` }
    })
    assert.equal(r.status, 401)
  })

  it('truncated JWT (only two parts) is rejected', async () => {
    const legit = signJwt({ userId: USER_A })
    const truncated = legit.split('.').slice(0, 2).join('.')
    const r = await server.request('/api/leads?workspaceId=' + WS_A, {
      headers: { Authorization: `Bearer ${truncated}` }
    })
    assert.equal(r.status, 401)
  })

  it('extra parts in JWT (four segments) is rejected', async () => {
    const legit = signJwt({ userId: USER_A })
    const extra = legit + '.extrasegment'
    const r = await server.request('/api/leads?workspaceId=' + WS_A, {
      headers: { Authorization: `Bearer ${extra}` }
    })
    assert.equal(r.status, 401)
  })

  it('empty string token is rejected', async () => {
    const r = await server.request('/api/leads?workspaceId=' + WS_A, {
      headers: { Authorization: 'Bearer ' }
    })
    assert.equal(r.status, 401)
  })

  it('valid token but for nonexistent user → 401', async () => {
    const missingUserPrisma = createFakePrisma({
      user: { findUnique: async () => null },
      membership: { findFirst: async () => null }
    })
    installPrisma(missingUserPrisma)
    const r = await server.request('/api/leads?workspaceId=' + WS_A, {
      headers: { Authorization: bearer('ghost-user-not-in-db') }
    })
    assert.equal(r.status, 401)
    installPrisma(prisma) // restore
  })
})

// ── Privilege escalation: billing actions ─────────────────────────────────────

describe('Privilege escalation: billing requires owner/admin', () => {
  let prisma: FakePrisma
  let server: TestServer

  before(async () => {
    prisma = createFakePrisma({
      user: userLookup,
      membership: {
        findFirst: async (args: any) => {
          const { role } = args?.where ?? {}
          // USER_B is a plain member — never matches owner/admin role filter
          if (role?.in) return null
          return membershipFor(USER_B, WS_B)
        }
      },
      workspace: {
        findUnique: async () => ({
          id: WS_B, plan: 'free', subscriptionStatus: null, stripeCustomerId: null, stripeSubscriptionId: null
        })
      },
      usageRecord: { findMany: async () => [] }
    })
    installPrisma(prisma)
    server = await startTestServer('/api/workspaces', workspaceRouter)
  })

  after(async () => { await server.close(); resetPrisma() })

  it('POST /api/workspaces/:id/api-key/rotate — plain member gets 403', async () => {
    const r = await server.request('/api/workspaces/' + WS_B + '/api-key/rotate', {
      method: 'POST',
      headers: { Authorization: bearer(USER_B) }
    })
    assert.equal(r.status, 403)
  })

  it('DELETE /api/workspaces/:id/api-key — plain member gets 403', async () => {
    const r = await server.request('/api/workspaces/' + WS_B + '/api-key', {
      method: 'DELETE',
      headers: { Authorization: bearer(USER_B) }
    })
    assert.equal(r.status, 403)
  })
})

// ── Mass assignment guard ──────────────────────────────────────────────────────

describe('Mass assignment: extra fields are silently ignored', () => {
  let prisma: FakePrisma
  let server: TestServer
  let captured: any

  before(async () => {
    prisma = createFakePrisma({
      user: userLookup,
      membership: {
        findFirst: async (args: any) => {
          const { userId, workspaceId } = args?.where ?? {}
          if (userId === USER_A && workspaceId === WS_A) return { ...membershipFor(USER_A, WS_A), role: 'owner' }
          return null
        }
      },
      campaign: {
        findUnique: async () => ({ id: 'c1', workspaceId: WS_A, name: 'Old', goalType: 'BOOK_CALL', createdAt: new Date(), updatedAt: new Date() }),
        update: async (args: any) => { captured = args?.data; return { id: 'c1', ...args?.data } }
      }
    })
    installPrisma(prisma)
    server = await startTestServer('/api/campaigns', campaignsRouter)
  })

  after(async () => { await server.close(); resetPrisma() })

  it('cannot inject workspaceId via PATCH body to move campaign to another workspace', async () => {
    const r = await server.request('/api/campaigns/c1', {
      method: 'PATCH',
      headers: { Authorization: bearer(USER_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Legit', workspaceId: WS_B, id: 'c-evil', role: 'owner' })
    })
    assert.ok(r.status === 200 || r.status === 404, `unexpected ${r.status}`)
    if (captured) {
      assert.ok(!('workspaceId' in captured), 'workspaceId must not be in update data')
      assert.ok(!('id' in captured), 'id must not be in update data')
      assert.ok(!('role' in captured), 'role must not be in update data')
    }
  })
})
