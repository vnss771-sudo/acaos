// Unit tests for consent.ts — the per-recipient ConsentRecord lookups the
// send pipeline's fail-closed consent gate depends on (Phase 3 DPA/CASL work).
// Mirrors tests/lib-suppressions.test.ts's fake-prisma pattern for its sibling
// module: previously only exercised indirectly through route/worker tests
// with mocked prisma, leaving bulkCheckConsent's own normalization and
// predicate behavior untested in the unit tier.
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { hasConsent, bulkCheckConsent } from '../packages/backend-core/src/lib/consent.ts'
import { createFakePrisma, installPrisma, resetPrisma } from './helpers/integration.ts'

afterEach(() => resetPrisma())

test('hasConsent: true when a matching row exists, normalized case/whitespace-insensitively', async () => {
  const prisma = createFakePrisma({
    consentRecord: {
      findFirst: async (a: any) => (a.where.emailKey === 'user@x.com' ? { id: 'c1' } : null),
    },
  })
  installPrisma(prisma)

  assert.equal(await hasConsent('ws1', 'user@x.com'), true)
  assert.equal(await hasConsent('ws1', '  USER@X.COM  '), true, 'lookup normalizes case/whitespace before matching')
  assert.equal(await hasConsent('ws1', 'other@x.com'), false)
})

test('hasConsent: scoped to the given workspace', async () => {
  const prisma = createFakePrisma({
    consentRecord: {
      findFirst: async (a: any) => {
        assert.equal(a.where.workspaceId, 'ws1')
        return null
      },
    },
  })
  installPrisma(prisma)

  await hasConsent('ws1', 'user@x.com')
})

test('bulkCheckConsent: the returned predicate matches only recipients with a ConsentRecord, normalized on both sides', async () => {
  const prisma = createFakePrisma({
    consentRecord: { findMany: async () => [{ emailKey: 'consented@x.com' }] },
  })
  installPrisma(prisma)

  const hasIt = await bulkCheckConsent('ws1', ['consented@x.com', 'no-consent@x.com'])

  assert.equal(hasIt('CONSENTED@X.COM'), true, 'predicate normalizes its own argument')
  assert.equal(hasIt('no-consent@x.com'), false)
  assert.equal(hasIt('unseen@x.com'), false, 'an email never passed to bulkCheckConsent is never a false positive')
})

test('bulkCheckConsent: an empty email list still resolves to an always-false predicate', async () => {
  const prisma = createFakePrisma({
    consentRecord: { findMany: async (a: any) => { assert.deepEqual(a.where.emailKey.in, []); return [] } },
  })
  installPrisma(prisma)

  const hasIt = await bulkCheckConsent('ws1', [])
  assert.equal(hasIt('anyone@x.com'), false)
})
