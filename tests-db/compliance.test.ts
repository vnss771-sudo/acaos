// Database-backed tests for the in-product compliance surface: posture read/attest,
// consent records, auth gates, and the DORMANT send-readiness gate (off by default).

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { workspaceRouter } from '../apps/api/src/routes/workspaces/index.ts'
import { getSendReadiness } from '../apps/api/src/lib/sendReadiness.ts'
import { COMPLIANCE_TERMS_VERSION, SUBPROCESSORS_VERSION } from '../packages/backend-core/src/lib/subprocessors.ts'
import {
  prisma, resetDb, disconnect, seedUserWithWorkspace,
  startTestServer, bearer, type TestServer,
} from './helpers/db.ts'

let server: TestServer
before(async () => { server = await startTestServer('/api/workspaces', workspaceRouter) })
after(async () => { await server.close(); await disconnect() })
beforeEach(async () => { await resetDb() })

const req = (method: string, path: string, auth: string, body?: unknown) =>
  server.request(path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: auth },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

async function freshAuth(userId: string) {
  await prisma.user.update({ where: { id: userId }, data: { lastReauthAt: new Date() } })
}

test('GET returns the (initially empty) posture + disclosed sub-processors', async () => {
  const { user, workspace } = await seedUserWithWorkspace('c-get@x.test')
  const res = await req('GET', `/api/workspaces/${workspace.id}/compliance`, bearer(user.id))
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.posture.lawfulBasis, null)
  assert.equal(res.body.consentCount, 0)
  assert.equal(res.body.currentTermsVersion, COMPLIANCE_TERMS_VERSION)
  assert.equal(res.body.subprocessors.version, SUBPROCESSORS_VERSION)
  assert.ok(res.body.subprocessors.subprocessors.some((s: { name: string }) => s.name === 'OpenAI'))
})

test('PATCH attests posture: lawful basis + terms/sub-processor acknowledgements stamp versions', async () => {
  const { user, workspace } = await seedUserWithWorkspace('c-patch@x.test')
  await freshAuth(user.id)
  const res = await req('PATCH', `/api/workspaces/${workspace.id}/compliance`, bearer(user.id), {
    lawfulBasis: 'legitimate_interest', acceptTerms: true, acknowledgeSubprocessors: true, acknowledgeLia: true, targetsCanada: true,
  })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  const p = res.body.posture
  assert.equal(p.lawfulBasis, 'legitimate_interest')
  assert.equal(p.termsVersion, COMPLIANCE_TERMS_VERSION)
  assert.equal(p.subprocessorsAckVersion, SUBPROCESSORS_VERSION)
  assert.ok(p.termsAcceptedAt && p.subprocessorsAckAt && p.liaAcknowledgedAt)
  assert.equal(p.targetsCanada, true)
})

test('PATCH rejects an invalid lawful basis', async () => {
  const { user, workspace } = await seedUserWithWorkspace('c-bad@x.test')
  await freshAuth(user.id)
  const res = await req('PATCH', `/api/workspaces/${workspace.id}/compliance`, bearer(user.id), { lawfulBasis: 'whatever' })
  assert.equal(res.status, 400)
})

test('POST consent appends a record (normalized email), counted in GET', async () => {
  const { user, workspace } = await seedUserWithWorkspace('c-consent@x.test')
  const post = await req('POST', `/api/workspaces/${workspace.id}/consent`, bearer(user.id), {
    email: '  Prospect@Example.COM ', basis: 'express_consent', source: 'form', note: 'webinar opt-in',
  })
  assert.equal(post.status, 201, JSON.stringify(post.body))
  const row = await prisma.consentRecord.findFirst({ where: { workspaceId: workspace.id } })
  assert.equal(row?.emailKey, 'prospect@example.com')
  const get = await req('GET', `/api/workspaces/${workspace.id}/compliance`, bearer(user.id))
  assert.equal(get.body.consentCount, 1)
})

test('a non-admin member cannot attest posture', async () => {
  const { workspace } = await seedUserWithWorkspace('c-owner@x.test')
  const { user: member } = await seedUserWithWorkspace('c-member@x.test')
  await prisma.membership.create({ data: { userId: member.id, workspaceId: workspace.id, role: 'member' } })
  await freshAuth(member.id)
  const res = await req('PATCH', `/api/workspaces/${workspace.id}/compliance`, bearer(member.id), { lawfulBasis: 'consent' })
  assert.equal(res.status, 403)
})

test('PATCH requires step-up (stale auth is rejected)', async () => {
  const { user, workspace } = await seedUserWithWorkspace('c-stale@x.test')
  await prisma.user.update({ where: { id: user.id }, data: { lastReauthAt: new Date(Date.now() - 60 * 60_000) } })
  const res = await req('PATCH', `/api/workspaces/${workspace.id}/compliance`, bearer(user.id), { lawfulBasis: 'consent' })
  assert.equal(res.status, 403)
  assert.equal(res.body.code, 'REAUTH_REQUIRED')
})

test('send-readiness compliance gate is DORMANT by default and active only when enabled', async () => {
  const { workspace } = await seedUserWithWorkspace('c-gate@x.test')
  const saved = process.env.COMPLIANCE_GATE_ENABLED
  try {
    // Off → no compliance checks added.
    delete process.env.COMPLIANCE_GATE_ENABLED
    const off = await getSendReadiness(workspace.id)
    assert.ok(!off.checks.some((c) => c.name === 'lawfulBasis'), 'no compliance check when gate is off')

    // On → lawful-basis + terms checks appear (and gate `ready` until satisfied).
    process.env.COMPLIANCE_GATE_ENABLED = 'true'
    const on = await getSendReadiness(workspace.id)
    assert.ok(on.checks.some((c) => c.name === 'lawfulBasis' && !c.ok))
    assert.ok(on.checks.some((c) => c.name === 'termsAccepted' && !c.ok))
    assert.ok(!on.checks.some((c) => c.name === 'caslConsent'), 'no CASL check unless targetsCanada')

    // targetsCanada → CASL consent check appears.
    await prisma.workspace.update({ where: { id: workspace.id }, data: { targetsCanada: true } })
    const canada = await getSendReadiness(workspace.id)
    assert.ok(canada.checks.some((c) => c.name === 'caslConsent' && !c.ok))
  } finally {
    if (saved === undefined) delete process.env.COMPLIANCE_GATE_ENABLED
    else process.env.COMPLIANCE_GATE_ENABLED = saved
  }
})
