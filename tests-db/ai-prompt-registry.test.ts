// DB-tier tests for AI generation provenance: resolvePromptVersionId find-or-creates
// the AiPromptVersion row for a generator config, reusing an unchanged config and
// versioning a changed one, per (workspace, type).

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { resolvePromptVersionId } from '../packages/backend-core/src/lib/aiPromptRegistry.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace } from './helpers/db.ts'

after(async () => { await disconnect() })
beforeEach(async () => { await resetDb() })

const base = (workspaceId: string) => ({
  workspaceId, type: 'OUTREACH', model: 'gpt-4o-mini', promptHash: 'hash-a', maxTokens: 1200, temperature: 0.4,
})

test('first resolve creates version 1 with the recorded config', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const id = await resolvePromptVersionId(base(workspace.id))
  assert.ok(id)
  const row = await prisma.aiPromptVersion.findUnique({ where: { id: id! } })
  assert.equal(row!.version, 1)
  assert.equal(row!.type, 'OUTREACH')
  assert.equal(row!.model, 'gpt-4o-mini')
  assert.equal(row!.promptHash, 'hash-a')
  assert.equal(row!.maxTokens, 1200)
  assert.equal(row!.isActive, true)
})

test('an unchanged config reuses the same row (no new version)', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const first = await resolvePromptVersionId(base(workspace.id))
  const second = await resolvePromptVersionId(base(workspace.id))
  assert.equal(first, second)
  assert.equal(await prisma.aiPromptVersion.count({ where: { workspaceId: workspace.id } }), 1)
})

test('a changed config (new hash) creates the next version', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await resolvePromptVersionId(base(workspace.id))
  const v2 = await resolvePromptVersionId({ ...base(workspace.id), promptHash: 'hash-b', model: 'gpt-4o' })
  const row = await prisma.aiPromptVersion.findUnique({ where: { id: v2! } })
  assert.equal(row!.version, 2)
  assert.equal(row!.model, 'gpt-4o')
  assert.equal(await prisma.aiPromptVersion.count({ where: { workspaceId: workspace.id, type: 'OUTREACH' } }), 2)
})

test('versioning is independent per (workspace, type)', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await resolvePromptVersionId(base(workspace.id))
  const reply = await resolvePromptVersionId({ ...base(workspace.id), type: 'REPLY_ANALYSIS', promptHash: 'hash-r' })
  const row = await prisma.aiPromptVersion.findUnique({ where: { id: reply! } })
  assert.equal(row!.version, 1, 'a different type starts its own version sequence')
})

test('concurrent resolves of the same config do not create duplicate rows', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const ids = await Promise.all(Array.from({ length: 5 }, () => resolvePromptVersionId(base(workspace.id))))
  // All resolve to a single version row (races collapse to the winner).
  const unique = new Set(ids.filter(Boolean))
  assert.equal(unique.size, 1)
  assert.equal(await prisma.aiPromptVersion.count({ where: { workspaceId: workspace.id } }), 1)
})
