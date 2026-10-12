// E2 (database tier): POST /api/workspaces/:id/compliance/abn. The ABR is stubbed at the
// global fetch seam — no network, no real GUID.

import { test, before, after, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { workspaceRouter } from '../apps/api/src/routes/workspaces/index.ts'
import { sendCampaignBatch } from './helpers/workerJobs.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace, allowAutonomousSending, startTestServer, bearer, type TestServer } from './helpers/db.ts'

let server: TestServer
const GUID = 'route-guid-SECRET-1234'
const ABN = '51824753556'
const savedGuid = process.env.ABR_GUID

before(async () => { server = await startTestServer('/api/workspaces', workspaceRouter) })
after(async () => { await server.close(); await disconnect() })
beforeEach(async () => { await resetDb(); process.env.ABR_GUID = GUID })
afterEach(() => {
  mock.restoreAll()
  if (savedGuid === undefined) delete process.env.ABR_GUID; else process.env.ABR_GUID = savedGuid
})

const post = (workspaceId: string, auth: string, abn: string) =>
  server.request(`/api/workspaces/${workspaceId}/compliance/abn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth }, body: JSON.stringify({ abn }),
  })

// Stub only ABR traffic; the test server itself talks to localhost via the same global fetch.
function stubAbr(payload: Record<string, unknown> | { status: number }) {
  const real = globalThis.fetch
  const urls: string[] = []
  mock.method(globalThis, 'fetch', async (input: any, init?: any) => {
    const u = String(input)
    if (!u.startsWith('https://abr.business.gov.au/')) return real(input, init)
    urls.push(u)
    if ('status' in payload) return new Response('upstream error', { status: payload.status as number })
    return new Response(`cb(${JSON.stringify({ Abn: ABN, AbnStatus: 'Active', EntityName: 'ACME PTY LTD', EntityTypeName: 'Australian Private Company', Message: '', ...payload })})`)
  })
  return urls
}

test('verifies an active ABN, stores it, audits it, and never echoes the GUID', async () => {
  const { user, workspace } = await seedUserWithWorkspace('abn-ok@x.test')
  const urls = stubAbr({})
  const res = await post(workspace.id, bearer(user.id), '51 824 753 556')
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.abn, ABN); assert.equal(res.body.status, 'active')
  assert.equal(urls.length, 1)
  const ws = await prisma.workspace.findUnique({ where: { id: workspace.id } })
  assert.equal(ws!.senderAbn, ABN); assert.equal(ws!.senderAbnStatus, 'active'); assert.equal(ws!.senderAbnEntityName, 'ACME PTY LTD')
  assert.ok(ws!.senderAbnVerifiedAt)
  const audit = await prisma.auditEvent.findFirst({ where: { workspaceId: workspace.id, type: 'compliance.abn.verified' } })
  assert.ok(audit)
  assert.ok(!JSON.stringify(res.body).includes('SECRET') && !JSON.stringify(audit).includes('SECRET'))
})

test('a cancelled ABN is rejected (422) and any previously verified ABN is cleared', async () => {
  const { user, workspace } = await seedUserWithWorkspace('abn-cancel@x.test')
  await prisma.workspace.update({ where: { id: workspace.id }, data: { senderAbn: ABN, senderAbnStatus: 'active' } })
  stubAbr({ AbnStatus: 'Cancelled' })
  const res = await post(workspace.id, bearer(user.id), ABN)
  assert.equal(res.status, 422)
  const ws = await prisma.workspace.findUnique({ where: { id: workspace.id } })
  assert.equal(ws!.senderAbn, null); assert.equal(ws!.senderAbnStatus, null)
})

test('invalid checksum → 400 without calling the ABR; unknown ABN → 404; no GUID → 503', async () => {
  const { user, workspace } = await seedUserWithWorkspace('abn-bad@x.test')
  const urls = stubAbr({ Abn: '', Message: 'Search text is not a valid ABN or ACN' })
  assert.equal((await post(workspace.id, bearer(user.id), '51824753557')).status, 400)
  assert.equal(urls.length, 0)
  assert.equal((await post(workspace.id, bearer(user.id), ABN)).status, 404)
  assert.equal(urls.length, 1)
  delete process.env.ABR_GUID
  assert.equal((await post(workspace.id, bearer(user.id), ABN)).status, 503)
  assert.equal(urls.length, 1, 'no request without a configured GUID')
})

test('ABR outage → 502 with no upstream detail or GUID', async () => {
  const { user, workspace } = await seedUserWithWorkspace('abn-down@x.test')
  stubAbr({ status: 400 })
  const res = await post(workspace.id, bearer(user.id), ABN)
  assert.equal(res.status, 502)
  assert.ok(!JSON.stringify(res.body).includes('SECRET') && !JSON.stringify(res.body).includes('upstream error'))
  const ws = await prisma.workspace.findUnique({ where: { id: workspace.id } })
  assert.equal(ws!.senderAbn, null)
})

test('a non-admin member cannot verify (and the ABR is not called)', async () => {
  const { workspace } = await seedUserWithWorkspace('abn-owner@x.test')
  const { user: member } = await seedUserWithWorkspace('abn-member@x.test')
  await prisma.membership.create({ data: { userId: member.id, workspaceId: workspace.id, role: 'member' } })
  const urls = stubAbr({})
  const res = await post(workspace.id, bearer(member.id), ABN)
  assert.ok(res.status === 403 || res.status === 404, String(res.status))
  assert.equal(urls.length, 0)
})

// ── footer wiring in the worker ──────────────────────────────────────────────
async function sendOne(ws: Record<string, unknown>) {
  const { workspace } = await seedUserWithWorkspace()
  await prisma.workspaceEmailConfig.create({ data: { workspaceId: workspace.id, smtpHost: 'smtp.acme.test', smtpFrom: 'sales@acme.test' } })
  await allowAutonomousSending(workspace.id)
  await prisma.workspace.update({ where: { id: workspace.id }, data: { senderBusinessName: 'Acme', senderPostalAddress: '1 Test St', ...ws } })
  const campaign = await prisma.campaign.create({ data: { workspaceId: workspace.id, name: 'C', goalType: 'BOOK_MEETINGS' } })
  const lead = await prisma.lead.create({ data: { workspaceId: workspace.id, campaignId: campaign.id, businessName: 'B', email: 'x@buyer.test', stage: 'RESEARCHED' } })
  await prisma.outreachDraft.create({ data: { leadId: lead.id, workspaceId: workspace.id, subject: 'Hi', emailBody: 'Hello there' } })
  const html: string[] = []
  const fn = (async (_to: string, _s: string, h: string) => { html.push(h); return { messageId: '<m@acaos.test>' } }) as unknown as typeof import('../packages/backend-core/src/services/mail.ts').sendMail
  const r = await sendCampaignBatch(campaign.id, workspace.id, undefined, undefined, { sendMail: fn })
  assert.equal(r.sent, 1)
  return html[0]!
}

test('campaign email footer prints the ABN only when verified active', async () => {
  assert.match(await sendOne({ senderAbn: ABN, senderAbnStatus: 'active' }), /ABN 51 824 753 556/)
  await resetDb()
  assert.ok(!(await sendOne({ senderAbn: ABN, senderAbnStatus: null })).includes('ABN '), 'unverified ABN is never printed')
  await resetDb()
  assert.ok(!(await sendOne({})).includes('ABN '))
})
