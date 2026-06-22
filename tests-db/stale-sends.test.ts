// DB-tier test for stale-SENDING recovery: a SENDING outbox row left past the
// threshold is reclaimed as FAILED (freeing the send cap); recent SENDING rows and
// already-terminal rows are untouched. Fail-closed — never re-sent.

import { test, beforeEach, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { recoverStaleSends } from '../packages/backend-core/src/lib/staleSends.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace } from './helpers/db.ts'

after(async () => { await disconnect() })
beforeEach(async () => { await resetDb() })

const savedEnv: Record<string, string | undefined> = {}
function setEnv(k: string, v: string) { if (!(k in savedEnv)) savedEnv[k] = process.env[k]; process.env[k] = v }
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  for (const k of Object.keys(savedEnv)) delete savedEnv[k]
})

async function seedSend(workspaceId: string, status: string, claimedAt: Date) {
  const campaign = await prisma.campaign.create({ data: { workspaceId, name: 'C', goalType: 'BOOK_MEETINGS' } })
  return prisma.outreachSent.create({
    data: { workspaceId, campaignId: campaign.id, toEmail: `x${Math.random()}@b.test`, subject: 'Hi', body: 'x', status: status as never, claimedAt },
  })
}

test('reclaims a SENDING row older than the threshold as FAILED', async () => {
  const { workspace } = await seedUserWithWorkspace()
  setEnv('STALE_SENDING_RECOVERY_MINUTES', '120')
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000) // 3h ago
  const stale = await seedSend(workspace.id, 'SENDING', old)

  const n = await recoverStaleSends()
  assert.equal(n, 1)
  const after = await prisma.outreachSent.findUnique({ where: { id: stale.id } })
  assert.equal(after!.status, 'FAILED')
  assert.ok(after!.failedAt)
  assert.match(after!.lastError ?? '', /stale SENDING reclaimed/)
})

test('leaves a recent SENDING row and terminal rows untouched', async () => {
  const { workspace } = await seedUserWithWorkspace()
  setEnv('STALE_SENDING_RECOVERY_MINUTES', '120')
  const recent = await seedSend(workspace.id, 'SENDING', new Date(Date.now() - 5 * 60 * 1000)) // 5 min ago
  const sent = await seedSend(workspace.id, 'SENT', new Date(Date.now() - 10 * 60 * 60 * 1000))

  const n = await recoverStaleSends()
  assert.equal(n, 0)
  assert.equal((await prisma.outreachSent.findUnique({ where: { id: recent.id } }))!.status, 'SENDING')
  assert.equal((await prisma.outreachSent.findUnique({ where: { id: sent.id } }))!.status, 'SENT')
})
