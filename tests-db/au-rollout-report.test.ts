// The targetsAustralia rollout report must be read-only and must never print recipient addresses or names.
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { prisma, resetDb, disconnect, seedUserWithWorkspace } from './helpers/db.ts'

after(async () => { await disconnect() })
beforeEach(async () => { await resetDb() })

const run = (...args: string[]) => spawnSync(process.execPath, ['scripts/report-au-rollout.mjs', ...args], {
  cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8',
})

test('report counts flagged/unflagged workspaces and .au senders without exposing addresses or names', async () => {
  const a = await seedUserWithWorkspace('rep-a@x.test')   // sends to .au, not flagged
  const b = await seedUserWithWorkspace('rep-b@x.test')   // flagged
  const c = await seedUserWithWorkspace('rep-c@x.test')   // sends only to .com
  await prisma.workspace.update({ where: { id: b.workspace.id }, data: { targetsAustralia: true } })
  const mk = (workspaceId: string, toEmail: string) => prisma.outreachSent.create({ data: { workspaceId, toEmail, subject: 's', body: 'b', status: 'SENT', sentAt: new Date() } })
  await mk(a.workspace.id, 'secret.person@tradie.com.au')
  await mk(a.workspace.id, 'other@example.com')
  await mk(c.workspace.id, 'someone@example.com')
  await prisma.consentRecord.create({ data: { workspaceId: b.workspace.id, emailKey: 'x@y.test', basis: 'express', source: 'manual' } })

  const before = await prisma.workspace.findMany({ orderBy: { id: 'asc' } })
  const r = run('--json')
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.workspaces.total, 3)
  assert.equal(out.workspaces.targetsAustralia, 1)
  assert.equal(out.sendingInWindow.messagesToAuTld, 1)
  assert.equal(out.sendingInWindow.unflaggedWorkspacesWithAuTldRecipients, 1)
  assert.deepEqual(out.unflaggedAuSenderWorkspaceIds.map((w: { id: string }) => w.id), [a.workspace.id])
  assert.equal(out.consentRecordsByBasis.express, 1)
  for (const secret of ['secret.person', 'tradie.com.au', 'x@y.test', a.workspace.name]) assert.ok(!r.stdout.includes(secret), `output must not contain ${secret}`)
  assert.ok(!run().stdout.includes('secret.person'))
  assert.deepEqual(await prisma.workspace.findMany({ orderBy: { id: 'asc' } }), before, 'read-only: no workspace was changed')
})
