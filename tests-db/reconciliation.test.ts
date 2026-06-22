// DB-tier tests for ledger↔projection reconciliation: detect CampaignDailyStats
// drift from the ContactEvent ledger and rebuild it. Bounded by the trailing window.

import { test, beforeEach, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { reconcileCampaignStats } from '../packages/backend-core/src/lib/reconciliation.ts'
import { utcDayStart } from '../packages/backend-core/src/lib/campaignStats.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace } from './helpers/db.ts'

after(async () => { await disconnect() })
beforeEach(async () => { await resetDb() })

const savedEnv: Record<string, string | undefined> = {}
function setEnv(k: string, v: string) { if (!(k in savedEnv)) savedEnv[k] = process.env[k]; process.env[k] = v }
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  for (const k of Object.keys(savedEnv)) delete savedEnv[k]
})

async function seedSentEvents(workspaceId: string, campaignId: string, n: number, when: Date) {
  await prisma.contactEvent.createMany({
    data: Array.from({ length: n }, (_, i) => ({ workspaceId, campaignId, emailKey: `r${i}@x.test`, type: 'SENT' as const, occurredAt: when })),
  })
}

test('matching ledger and projection report no drift', async () => {
  const { workspace } = await seedUserWithWorkspace()
  setEnv('STATS_RECONCILE_WINDOW_DAYS', '2')
  const campaign = await prisma.campaign.create({ data: { workspaceId: workspace.id, name: 'C', goalType: 'BOOK_MEETINGS' } })
  const today = new Date()
  await seedSentEvents(workspace.id, campaign.id, 3, today)
  await prisma.campaignDailyStats.create({ data: { workspaceId: workspace.id, campaignId: campaign.id, date: utcDayStart(today), sent: 3 } })

  const report = await reconcileCampaignStats({ rebuild: true })
  assert.deepEqual(report.drifted, [])
  assert.equal(report.workspacesRebuilt, 0)
})

test('a drifted projection is detected and rebuilt to match the ledger', async () => {
  const { workspace } = await seedUserWithWorkspace()
  setEnv('STATS_RECONCILE_WINDOW_DAYS', '2')
  const campaign = await prisma.campaign.create({ data: { workspaceId: workspace.id, name: 'C', goalType: 'BOOK_MEETINGS' } })
  const today = new Date()
  await seedSentEvents(workspace.id, campaign.id, 5, today)
  // Projection wrongly says 2 (drift of 3 vs the ledger's 5).
  await prisma.campaignDailyStats.create({ data: { workspaceId: workspace.id, campaignId: campaign.id, date: utcDayStart(today), sent: 2 } })

  const report = await reconcileCampaignStats({ rebuild: true })
  assert.ok(report.drifted.some(d => d.field === 'sent' && d.ledger === 5 && d.projection === 2))
  assert.equal(report.workspacesRebuilt, 1)
  // After rebuild the projection converges to the ledger.
  const row = await prisma.campaignDailyStats.findFirst({ where: { campaignId: campaign.id } })
  assert.equal(row!.sent, 5)
})

test('drift outside the reconcile window is ignored', async () => {
  const { workspace } = await seedUserWithWorkspace()
  setEnv('STATS_RECONCILE_WINDOW_DAYS', '2')
  const campaign = await prisma.campaign.create({ data: { workspaceId: workspace.id, name: 'C', goalType: 'BOOK_MEETINGS' } })
  const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) // 10 days ago, outside window
  await seedSentEvents(workspace.id, campaign.id, 4, old)
  await prisma.campaignDailyStats.create({ data: { workspaceId: workspace.id, campaignId: campaign.id, date: utcDayStart(old), sent: 99 } })

  const report = await reconcileCampaignStats({ rebuild: true })
  assert.deepEqual(report.drifted, [], 'old days are outside the bounded window')
})
