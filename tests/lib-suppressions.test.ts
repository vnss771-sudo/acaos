// Unit tests for lib/suppressions — the email-suppression primitive behind
// unsubscribe / bounce handling. Email normalisation here is load-bearing: a
// case- or whitespace-mismatched address that escapes suppression is a
// compliance incident, so every entry point lower-cases and trims.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { isSuppressed, suppress, bulkCheckSuppression } from '../apps/api/src/lib/suppressions.ts'
import { createFakePrisma, installPrisma, resetPrisma, type FakePrisma } from './helpers/integration.ts'

let fake: FakePrisma

// A tiny in-memory suppression store keyed by `${workspaceId}\0${email}`.
let store: Map<string, { workspaceId: string; email: string; reason: string }>

beforeEach(() => {
  store = new Map()
  const key = (ws: string, email: string) => `${ws}\0${email}`
  fake = createFakePrisma({
    suppression: {
      findUnique: async (a: any) => {
        const { workspaceId, email } = a.where.workspaceId_email
        return store.get(key(workspaceId, email)) ?? null
      },
      upsert: async (a: any) => {
        const { workspaceId, email } = a.where.workspaceId_email
        const existing = store.get(key(workspaceId, email))
        const row = existing
          ? { ...existing, reason: a.update.reason }
          : { workspaceId, email, reason: a.create.reason }
        store.set(key(workspaceId, email), row)
        return row
      },
      findMany: async (a: any) => {
        const wanted = new Set(a.where.email.in as string[])
        return [...store.values()].filter(
          (r) => r.workspaceId === a.where.workspaceId && wanted.has(r.email)
        )
      },
    },
  })
  installPrisma(fake)
})
afterEach(() => resetPrisma())

test('suppress() lower-cases and trims the email before storing', async () => {
  await suppress('ws1', '  Prospect@Example.COM ')
  const arg = (fake.callsTo('suppression', 'upsert')[0].args[0]) as any
  assert.equal(arg.where.workspaceId_email.email, 'prospect@example.com')
  assert.equal(arg.create.email, 'prospect@example.com')
})

test('suppress() defaults the reason to UNSUBSCRIBED', async () => {
  await suppress('ws1', 'a@b.com')
  const arg = (fake.callsTo('suppression', 'upsert')[0].args[0]) as any
  assert.equal(arg.create.reason, 'UNSUBSCRIBED')
})

test('suppress() records an explicit reason (e.g. BOUNCED)', async () => {
  await suppress('ws1', 'a@b.com', 'BOUNCED')
  assert.equal(store.get('ws1\0a@b.com')?.reason, 'BOUNCED')
})

test('suppress() is idempotent and updates the reason on re-suppression', async () => {
  await suppress('ws1', 'a@b.com', 'UNSUBSCRIBED')
  await suppress('ws1', 'a@b.com', 'MANUAL')
  assert.equal(store.size, 1)
  assert.equal(store.get('ws1\0a@b.com')?.reason, 'MANUAL')
})

test('isSuppressed() matches regardless of input casing/whitespace', async () => {
  await suppress('ws1', 'person@example.com')
  assert.equal(await isSuppressed('ws1', 'PERSON@example.com'), true)
  assert.equal(await isSuppressed('ws1', '  person@example.com  '), true)
})

test('isSuppressed() is scoped per workspace', async () => {
  await suppress('ws1', 'person@example.com')
  // Same address, different workspace — must NOT be suppressed (tenant isolation).
  assert.equal(await isSuppressed('ws2', 'person@example.com'), false)
})

test('isSuppressed() returns false for an address that was never suppressed', async () => {
  assert.equal(await isSuppressed('ws1', 'nobody@example.com'), false)
})

test('bulkCheckSuppression() returns only the suppressed, normalised addresses', async () => {
  await suppress('ws1', 'one@example.com')
  await suppress('ws1', 'two@example.com')
  const hits = await bulkCheckSuppression('ws1', ['ONE@example.com', 'three@example.com', '  two@example.com '])
  assert.deepEqual([...hits].sort(), ['one@example.com', 'two@example.com'])
})

test('bulkCheckSuppression() ignores hits from other workspaces', async () => {
  await suppress('ws-other', 'shared@example.com')
  const hits = await bulkCheckSuppression('ws1', ['shared@example.com'])
  assert.equal(hits.size, 0)
})
