// D1 verification: run scripts/check-leaked-source-errors.mjs against an isolated
// database fixture. It must detect credential-bearing rows, exit non-zero, never
// print the secret, and write nothing.

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { prisma, resetDb, disconnect, seedUserWithWorkspace } from './helpers/db.ts'

after(async () => { await disconnect() })
beforeEach(async () => { await resetDb() })

const run = () => spawnSync(process.execPath, ['scripts/check-leaked-source-errors.mjs'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, NODE_OPTIONS: '' },
  encoding: 'utf8',
})

test('checker: clean fixture exits 0', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await prisma.discoverySourceState.create({ data: { workspaceId: workspace.id, source: 'austender', lastError: 'austender 500: upstream down' } })
  const r = run()
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /0 contain a credential-like query parameter/)
})

test('checker: flags leaked key=/token= rows, exits 1, never prints the secret, writes nothing', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const SECRET = 'SUPERSECRETKEY-123'
  await prisma.discoverySourceState.create({ data: { workspaceId: workspace.id, source: 'planningalerts', lastError: `Request to https://api.test/x?key=${SECRET}&page=1 timed out after 20000ms` } })
  await prisma.discoverySourceState.create({ data: { workspaceId: workspace.id, source: 'austender', lastWarning: `retry https://a.test/?access_token=${SECRET}` } })
  await prisma.discoverySourceState.create({ data: { workspaceId: workspace.id, source: 'other', lastError: 'plain failure' } })
  const before = await prisma.discoverySourceState.findMany({ orderBy: { source: 'asc' } })

  const r = run()
  assert.equal(r.status, 1)
  assert.match(r.stdout, /3 rows; 2 contain/)
  assert.ok(!r.stdout.includes(SECRET) && !r.stderr.includes(SECRET), 'the secret must never be printed')
  assert.ok(!r.stdout.includes(workspace.id) && !/source=|workspace=/.test(r.stdout), 'aggregate counts only: no workspace ids or sources')
  assert.deepEqual(await prisma.discoverySourceState.findMany({ orderBy: { source: 'asc' } }), before, 'read-only: no row changed')
})
