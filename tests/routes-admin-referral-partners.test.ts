import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { adminRouter } from '../apps/api/src/routes/admin.ts'
import { resetRedisConnectionForTests } from '@acaos/backend-core/lib/queues.js'
import {
  createFakePrisma, installPrisma, resetPrisma, startTestServer, bearer,
  type FakePrisma, type TestServer,
} from './helpers/integration.ts'

const USER = 'u1'
const headers = { Authorization: bearer(USER), 'Content-Type': 'application/json' }
const userSpec = (isPlatformAdmin: boolean) => ({
  findUnique: async () => ({ id: USER, email: 'u1@a.test', name: null, emailVerified: true, isPlatformAdmin }),
})

let server: TestServer
beforeEach(async () => {
  delete process.env.ADMIN_EMAIL
  server = await startTestServer('/api/admin', adminRouter)
})
afterEach(async () => {
  await server.close()
  resetPrisma()
  try { await resetRedisConnectionForTests() } catch { /* never connected */ }
})

test('non-admin cannot list or create referral partners', async () => {
  installPrisma(createFakePrisma({ user: userSpec(false) }) as FakePrisma)
  assert.equal((await server.request('/api/admin/referral-partners', { headers })).status, 403)
  const post = await server.request('/api/admin/referral-partners', { method: 'POST', headers, body: JSON.stringify({ code: 'abc', name: 'A' }) })
  assert.equal(post.status, 403)
})

test('admin lists partners with referred, paying and commission totals', async () => {
  installPrisma(createFakePrisma({
    user: userSpec(true),
    referralPartner: {
      findMany: async () => [{
        id: 'p1', code: 'ACC', name: 'Accounts', commissionPercent: 20,
        workspaces: [{ plan: 'starter', subscriptionStatus: 'active' }, { plan: 'free', subscriptionStatus: null }],
      }],
    },
  }) as FakePrisma)
  const res = await server.request('/api/admin/referral-partners', { headers })
  assert.equal(res.status, 200)
  const partners = res.body.partners as Array<Record<string, unknown>>
  assert.equal(partners[0].referred, 2)
  assert.equal(partners[0].paying, 1)
  assert.equal(partners[0].estimatedMonthlyCommissionCents, 2980)
  assert.equal('workspaces' in partners[0], false)
})

test('admin creates a partner with a normalised code; duplicates are 409', async () => {
  let existing: unknown = null
  installPrisma(createFakePrisma({
    user: userSpec(true),
    referralPartner: {
      findUnique: async () => existing,
      create: async ({ data }: { data: Record<string, unknown> }) => ({ id: 'p9', ...data }),
    },
    auditEvent: { create: async () => ({}) },
  }) as FakePrisma)
  const body = JSON.stringify({ code: 'coast-books', name: 'Coast Books' })
  const ok = await server.request('/api/admin/referral-partners', { method: 'POST', headers, body })
  assert.equal(ok.status, 201)
  const partner = ok.body.partner as Record<string, unknown>
  assert.equal(partner.code, 'COAST-BOOKS')
  assert.equal(partner.commissionPercent, 20)
  existing = { id: 'p9' }
  const dup = await server.request('/api/admin/referral-partners', { method: 'POST', headers, body })
  assert.equal(dup.status, 409)
})
