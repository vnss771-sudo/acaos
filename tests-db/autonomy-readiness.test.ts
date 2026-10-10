// Autonomous-outreach readiness gate (UQ-40), against a real database and the
// real worker. approvalMode=false is only a request: an unapproved draft must
// stay held for approval when ANY single readiness condition is missing, and
// send only when every one holds.
import { test, before, beforeEach, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { sendCampaignBatch } from './helpers/workerJobs.ts'
import { workspaceRouter } from '../apps/api/src/routes/workspaces/index.ts'
import { AUTONOMY_CONSENT_VERSION } from '../packages/backend-core/src/lib/autonomyReadiness.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace, seedUser, allowAutonomousSending, startTestServer, bearer, type TestServer } from './helpers/db.ts'

let server: TestServer
before(async () => { server = await startTestServer('/api/workspaces', workspaceRouter) })
after(async () => { await server.close(); await disconnect() })
beforeEach(async () => { await resetDb() })
const ENV_KEYS = ['AUTONOMOUS_OUTREACH_MODE', 'AUTONOMY_MIN_REVIEWED_DRAFTS', 'AUTONOMY_MIN_APPROVAL_RATE', 'REPUTATION_MIN_SENDS', 'AUTONOMY_MIN_SENDS', 'SAFE_LAUNCH_MODE', 'FEATURE_SEND'] as const
const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] } })

function mailer() {
  const sent: string[] = []
  const fn = async (to: string) => { sent.push(to); return { messageId: `<a-${sent.length}@acaos.test>` } }
  return { fn: fn as unknown as typeof import('../packages/backend-core/src/services/mail.ts').sendMail, sent }
}

/** An autonomy-ready workspace with approvalMode=false and one unapproved draft. */
async function readyWorkspace() {
  const { user, workspace } = await seedUserWithWorkspace()
  await prisma.workspaceEmailConfig.create({ data: { workspaceId: workspace.id, smtpHost: 'smtp.acme.test', smtpFrom: 'sales@acme.test' } })
  await prisma.workspaceICP.create({ data: { workspaceId: workspace.id, approvalMode: false, targetIndustries: [], targetGeos: [], excludedIndustries: [] } })
  await allowAutonomousSending(workspace.id)
  const campaign = await prisma.campaign.create({ data: { workspaceId: workspace.id, name: 'Auto', goalType: 'BOOK_MEETINGS' } })
  const lead = await prisma.lead.create({ data: { workspaceId: workspace.id, campaignId: campaign.id, businessName: 'Acme', email: 'buyer@target.test', stage: 'RESEARCHED' } })
  await prisma.outreachDraft.create({ data: { leadId: lead.id, workspaceId: workspace.id, subject: 'Hi', emailBody: 'Hello there' } })
  return { user, workspace, campaign }
}

const run = async (w: { workspace: { id: string }; campaign: { id: string } }) => {
  const m = mailer()
  const r = await sendCampaignBatch(w.campaign.id, w.workspace.id, undefined, undefined, { sendMail: m.fn })
  return { sent: m.sent.length, held: r.skippedByReason.NO_APPROVED_DRAFT }
}

test('every condition met: an unapproved draft sends automatically', async () => {
  const w = await readyWorkspace()
  assert.deepEqual(await run(w), { sent: 1, held: 0 })
})

const blockers: Array<[string, (w: Awaited<ReturnType<typeof readyWorkspace>>) => Promise<void>]> = [
  ['the operator switch is off', async () => { delete process.env.AUTONOMOUS_OUTREACH_MODE }],
  ['safe-launch mode is on', async () => { process.env.SAFE_LAUNCH_MODE = 'true' }],
  ['the workspace never opted in', async (w) => { await prisma.workspace.update({ where: { id: w.workspace.id }, data: { autonomyOptInAt: null, autonomyConsentVersion: null } }) }],
  ['the opt-in is for an older consent version', async (w) => { await prisma.workspace.update({ where: { id: w.workspace.id }, data: { autonomyConsentVersion: '2020-01-01.v0' } }) }],
  ['too few drafts have been reviewed', async () => { process.env.AUTONOMY_MIN_REVIEWED_DRAFTS = '20' }],
  ['reviewed drafts were mostly rejected', async (w) => {
    process.env.AUTONOMY_MIN_REVIEWED_DRAFTS = '2'
    const other = await prisma.lead.create({ data: { workspaceId: w.workspace.id, businessName: 'Old', email: 'old@x.test', stage: 'DEAD' } })
    await prisma.outreachDraft.createMany({ data: [
      { leadId: other.id, workspaceId: w.workspace.id, subject: 'a', emailBody: 'a', status: 'REJECTED' },
      { leadId: other.id, workspaceId: w.workspace.id, subject: 'b', emailBody: 'b', status: 'APPROVED' },
    ] })
  }],
  ['sender reputation is unhealthy', async (w) => {
    process.env.REPUTATION_MIN_SENDS = '1'
    await prisma.contactEvent.createMany({ data: [
      { workspaceId: w.workspace.id, emailKey: 'x@y.test', type: 'SENT' },
      { workspaceId: w.workspace.id, emailKey: 'x@y.test', type: 'BOUNCED' },
    ] })
  }],
]

for (const [name, apply] of blockers) {
  test(`approvalMode=false still holds for approval when ${name}`, async () => {
    const w = await readyWorkspace()
    await apply(w)
    assert.deepEqual(await run(w), { sent: 0, held: 1 })
  })
}

test('autonomy API: members read the posture; only a fresh admin opts in, to the current version, audited', async () => {
  const { user, workspace } = await readyWorkspace()
  await prisma.workspace.update({ where: { id: workspace.id }, data: { autonomyOptInAt: null, autonomyConsentVersion: null } })
  const member = await seedUser('member@acme.test')
  await prisma.membership.create({ data: { userId: member.id, workspaceId: workspace.id, role: 'member' } })
  await prisma.user.updateMany({ data: { lastReauthAt: new Date() } })
  const call = (uid: string, method: string, body?: unknown) => server.request(`/api/workspaces/${workspace.id}/autonomy`, {
    method, headers: { Authorization: bearer(uid), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
  })

  const read = await call(member.id, 'GET')
  assert.equal(read.status, 200)
  assert.equal(read.body.ready, false)
  assert.ok(read.body.blockers.includes('NOT_OPTED_IN'))
  assert.equal(read.body.approvalModeOff, true)

  assert.equal((await call(member.id, 'PATCH', { optIn: true, consentVersion: AUTONOMY_CONSENT_VERSION })).status, 403)
  const stale = await call(user.id, 'PATCH', { optIn: true, consentVersion: 'old' })
  assert.equal(stale.status, 409)
  const optedIn = await call(user.id, 'PATCH', { optIn: true, consentVersion: AUTONOMY_CONSENT_VERSION })
  assert.equal(optedIn.status, 200, JSON.stringify(optedIn.body))
  assert.equal(optedIn.body.optedIn, true)
  assert.equal(optedIn.body.ready, true)
  assert.ok(await prisma.auditEvent.findFirst({ where: { workspaceId: workspace.id, type: 'autonomy.opt_in' } }))

  const out = await call(user.id, 'PATCH', { optIn: false })
  assert.equal(out.body.optedIn, false)
  assert.ok(out.body.blockers.includes('NOT_OPTED_IN'))
  assert.ok(await prisma.auditEvent.findFirst({ where: { workspaceId: workspace.id, type: 'autonomy.opt_out' } }))

  // Step-up: a stale credential can't opt in.
  await prisma.user.update({ where: { id: user.id }, data: { lastReauthAt: new Date(Date.now() - 24 * 3_600_000) } })
  assert.equal((await call(user.id, 'PATCH', { optIn: true, consentVersion: AUTONOMY_CONSENT_VERSION })).status, 403)
})
