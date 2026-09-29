// Onboarding → first approved send, against a REAL database. A brand-new
// workspace imports one real prospect through the onboarding endpoint and takes it
// all the way to a dispatched email:
//
//   onboarding import → score → ONBOARDING intent → draft → human approval →
//   materialised lead → campaign → send-readiness → send → OutreachSent (+provenance)
//
// Two hops don't go over HTTP, for the same reasons as golden-spine.test.ts: draft
// generation needs OpenAI (the stored draft stands in for its result), and the
// send route only enqueues a BullMQ job — so we run that job's processor
// (sendCampaignBatch) directly, with a stub mailer, for exactly the lead the send
// confirmation dispatches.

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { prospectsRouter } from '../apps/api/src/routes/prospects.ts'
import { sendCampaignBatch } from '../apps/worker/src/processors.ts'
import { getSendReadiness } from '../apps/api/src/lib/sendReadiness.ts'
import { AUTO_RECOMMEND_THRESHOLD } from '../packages/backend-core/src/lib/recommendationPolicy.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace, startTestServer, bearer, type TestServer } from './helpers/db.ts'

let server: TestServer
before(async () => { server = await startTestServer('/api/prospects', prospectsRouter) })
after(async () => { await server.close(); await disconnect() })
beforeEach(async () => { await resetDb() })

const json = (userId: string) => ({ Authorization: bearer(userId), 'Content-Type': 'application/json' })
const post = (path: string, userId: string, body: unknown = {}) =>
  server.request(path, { method: 'POST', headers: json(userId), body: JSON.stringify(body) })

async function makeSendReady(workspaceId: string) {
  await prisma.workspace.update({
    where: { id: workspaceId },
    data: {
      senderBusinessName: 'Northwind Field Services', senderPostalAddress: '100 Market St, Austin, TX',
      lawfulBasis: 'legitimate_interest', termsAcceptedAt: new Date(),
    },
  })
  await prisma.workspaceEmailConfig.create({ data: { workspaceId, smtpHost: 'smtp.northwind.test', smtpFrom: 'sales@northwind.test' } })
}

test('new workspace: one real prospect reaches an approved, sent email with intent provenance', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  await makeSendReady(workspace.id)

  // 1) Onboarding import — a real prospect with a contact email.
  const res = await post('/api/prospects/onboarding-import', user.id, {
    workspaceId: workspace.id,
    rows: [{ companyName: 'Acme Plumbing', contactEmail: 'mark@acmeplumbing.test', contactName: 'Mark', domain: 'acmeplumbing.test' }],
  })
  assert.equal(res.status, 201)
  const body = res.body as { imported: number; intents: { id: string; prospectId: string }[] }
  assert.equal(body.imported, 1)
  assert.equal(body.intents.length, 1, 'an intent was prepared for the prospect')
  const { id: intentId, prospectId } = body.intents[0]

  // 2) Scored normally — and below the auto-recommend line, which is why onboarding
  //    had to prepare it. The intent says so: origin ONBOARDING, not RECOMMENDATION.
  const prospect = await prisma.prospect.findUniqueOrThrow({ where: { id: prospectId } })
  assert.ok(prospect.opportunityScore < AUTO_RECOMMEND_THRESHOLD, 'a signal-less prospect scores below the normal threshold')
  const intent = await prisma.outreachIntent.findUniqueOrThrow({ where: { id: intentId } })
  assert.equal(intent.origin, 'ONBOARDING')
  assert.equal(intent.status, 'PROPOSED')
  assert.ok(intent.recommendationId, 'backed by a recommendation record')

  // 3) Draft (stored generation result), 4) human approval over HTTP.
  await prisma.outreachIntent.update({ where: { id: intentId }, data: { draftSubject: 'Quick idea for Acme', draftBody: 'Hi Mark — a quick idea for your scheduling.', status: 'DRAFTED' } })
  assert.equal((await post(`/api/prospects/${prospectId}/intents/${intentId}/approve`, user.id)).status, 200)

  // 5) Materialise → sendable lead + APPROVED draft in a campaign.
  const mat = await post(`/api/prospects/${prospectId}/intents/${intentId}/materialize`, user.id)
  assert.equal(mat.status, 201)
  const { leadId, campaignId } = mat.body as { leadId: string; campaignId: string }
  // The prospect records its conversion, so "Convert to Lead" can't create a duplicate.
  assert.equal((await prisma.prospect.findUniqueOrThrow({ where: { id: prospectId } })).convertedLeadId, leadId)
  assert.equal((await post(`/api/prospects/${prospectId}/convert-to-lead`, user.id)).status, 409)

  // 6) The send gate's readiness checks pass for this workspace.
  assert.equal((await getSendReadiness(workspace.id)).ready, true)

  // 7) Send exactly this lead (what the confirmation dialog dispatches).
  const sent: string[] = []
  const sendMail = (async (to: string) => { sent.push(to); return { messageId: `<first-send@acaos.test>` } }) as never
  await sendCampaignBatch(campaignId, workspace.id, [leadId], undefined, { sendMail })
  assert.deepEqual(sent, ['mark@acmeplumbing.test'])

  // 8) Provenance: the OutreachSent row points back to the onboarding intent, which is now SENT.
  const outreach = await prisma.outreachSent.findFirstOrThrow({ where: { leadId } })
  assert.equal(outreach.outreachIntentId, intentId)
  assert.equal((await prisma.outreachIntent.findUniqueOrThrow({ where: { id: intentId } })).status, 'SENT')
})

test('onboarding import guardrails: email required, row cap, only before the first real intent', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const importRows = (rows: unknown[]) => post('/api/prospects/onboarding-import', user.id, { workspaceId: workspace.id, rows })

  assert.equal((await importRows([{ companyName: 'No Email Co' }])).status, 400, 'contact email is required')
  const eleven = Array.from({ length: 11 }, (_, i) => ({ companyName: `Co ${i}`, contactEmail: `c${i}@co.test` }))
  assert.equal((await importRows(eleven)).status, 400, 'at most 10 prospects')

  // Five prospects → only the top 3 get onboarding intents.
  const five = Array.from({ length: 5 }, (_, i) => ({ companyName: `Co ${i}`, contactEmail: `c${i}@co.test`, domain: `co${i}.test` }))
  const first = await importRows(five)
  assert.equal(first.status, 201)
  assert.equal((first.body as { intents: unknown[] }).intents.length, 3)
  assert.equal(await prisma.outreachIntent.count({ where: { workspaceId: workspace.id, origin: 'ONBOARDING' } }), 3)

  // The workspace now has real intents — onboarding import is closed.
  assert.equal((await importRows([{ companyName: 'Late Co', contactEmail: 'late@co.test' }])).status, 409)
})
