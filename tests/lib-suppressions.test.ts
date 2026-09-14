// Unit tests for suppressions.ts — the do-not-contact gate that campaign sends
// depend on (bulkCheckSuppression is on the hot send path; isSuppressed/suppress
// back the unsubscribe/bounce/complaint handlers). Previously exercised only
// incidentally through other modules' tests, with no direct coverage of
// isSuppressed or suppress at all.
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { isSuppressed, suppress, bulkCheckSuppression } from '../packages/backend-core/src/lib/suppressions.ts'
import { createFakePrisma, installPrisma, resetPrisma } from './helpers/integration.ts'

afterEach(() => resetPrisma())

test('isSuppressed: true when a matching row exists, normalized case/whitespace-insensitively', async () => {
  const prisma = createFakePrisma({
    suppression: {
      findUnique: async (a: any) => (a.where.workspaceId_emailKey.emailKey === 'user@x.com' ? { id: 's1' } : null),
    },
  })
  installPrisma(prisma)

  assert.equal(await isSuppressed('ws1', 'user@x.com'), true)
  assert.equal(await isSuppressed('ws1', '  USER@X.COM  '), true, 'lookup normalizes case/whitespace before matching')
  assert.equal(await isSuppressed('ws1', 'other@x.com'), false)
})

test('suppress: a first suppression creates a row keyed on the normalized email', async () => {
  const prisma = createFakePrisma({
    suppression: {
      upsert: async (a: any) => ({ id: 's1', ...a.create }),
    },
  })
  installPrisma(prisma)

  await suppress('ws1', '  User@X.com ', 'BOUNCED')

  const call = prisma.callsTo('suppression', 'upsert')[0].args[0] as any
  assert.equal(call.where.workspaceId_emailKey.emailKey, 'user@x.com')
  assert.equal(call.create.emailKey, 'user@x.com')
  assert.equal(call.create.email, 'User@X.com', 'the original casing is preserved on the record for display')
  assert.equal(call.create.reason, 'BOUNCED')
  assert.equal(call.update.reason, 'BOUNCED')
})

test('suppress: defaults to UNSUBSCRIBED and a re-suppression updates the reason instead of duplicating', async () => {
  const prisma = createFakePrisma({ suppression: { upsert: async (a: any) => ({ id: 's1', ...a.create }) } })
  installPrisma(prisma)

  await suppress('ws1', 'user@x.com')
  await suppress('ws1', 'user@x.com', 'COMPLAINT')

  const calls = prisma.callsTo('suppression', 'upsert')
  assert.equal(calls.length, 2, 'a re-suppression upserts (same key), it does not skip or duplicate')
  assert.equal((calls[0].args[0] as any).create.reason, 'UNSUBSCRIBED')
  assert.equal((calls[1].args[0] as any).update.reason, 'COMPLAINT')
})

test('bulkCheckSuppression: the returned predicate matches only suppressed emails, normalized on both sides', async () => {
  const prisma = createFakePrisma({
    suppression: { findMany: async () => [{ emailKey: 'blocked@x.com' }] },
  })
  installPrisma(prisma)

  const isBlocked = await bulkCheckSuppression('ws1', ['blocked@x.com', 'ok@x.com'])

  assert.equal(isBlocked('BLOCKED@X.COM'), true, 'predicate normalizes its own argument')
  assert.equal(isBlocked('ok@x.com'), false)
  assert.equal(isBlocked('unseen@x.com'), false, 'an email never passed to bulkCheckSuppression is never a false positive')
})

test('bulkCheckSuppression: an empty email list still resolves to an always-false predicate', async () => {
  const prisma = createFakePrisma({
    suppression: { findMany: async (a: any) => { assert.deepEqual(a.where.emailKey.in, []); return [] } },
  })
  installPrisma(prisma)

  const isBlocked = await bulkCheckSuppression('ws1', [])
  assert.equal(isBlocked('anyone@x.com'), false)
})
