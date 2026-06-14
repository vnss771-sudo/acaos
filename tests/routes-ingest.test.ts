// Integration tests for the /api/ingest router (P5 — ingest / bulk dedup).
//
// Covers API-key workspace scoping, batch + cross-workspace email
// deduplication, batch caps, campaign validation, and owner-only API-key
// management.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { ingestRouter } from '../apps/api/src/routes/ingest.ts'
import { hashApiKey } from '../apps/api/src/lib/apiKeys.ts'
import {
  createFakePrisma,
  installPrisma,
  resetPrisma,
  startTestServer,
  bearer,
  type FakePrisma,
  type TestServer,
} from './helpers/integration.ts'

const WS = 'ws1'
const API_KEY = 'ingest-key-xyz'
const OWNER = 'owner-1'
const NON_OWNER = 'member-1'

// Emails already present in the workspace (lowercased).
let existingEmails: string[]
// Current lead count in the workspace, used by the plan-capacity check.
let leadCount: number
let prisma: FakePrisma
let server: TestServer

function spec() {
  return {
    workspace: {
      findUnique: async (args: any) => {
        // requireIngestKey middleware resolves the workspace by key hash.
        if (args?.where?.ingestApiKey === hashApiKey(API_KEY)) return { id: WS, plan: 'free' }
        // Capacity check + delete-eviction look the workspace up by id.
        if (args?.where?.id === WS) return { id: WS, plan: 'free', subscriptionStatus: null, ingestApiKey: hashApiKey(API_KEY) }
        return null
      },
      update: async (args: any) => ({ id: args?.where?.id }),
    },
    campaign: {
      findFirst: async (args: any) =>
        args?.where?.id === 'camp-1' && args?.where?.workspaceId === WS ? { id: 'camp-1' } : null,
    },
    lead: {
      count: async () => leadCount,
      findMany: async (args: any) => {
        const wanted = (args?.where?.email?.in ?? []) as string[]
        return existingEmails
          .filter((e) => wanted.includes(e))
          .map((email) => ({ email }))
      },
      create: async (args: any) => ({ id: `lead-${Math.random().toString(36).slice(2)}`, ...args.data }),
    },
    user: {
      findUnique: async (args: any) => ({ id: args?.where?.id, email: 'x@y.test', name: null }),
    },
    membership: {
      findFirst: async (args: any) => {
        if (args?.where?.workspaceId !== WS) return null
        if (args?.where?.userId === OWNER) return { role: 'owner' }
        if (args?.where?.userId === NON_OWNER) return { role: 'member' }
        return null
      },
    },
  }
}

beforeEach(async () => {
  existingEmails = []
  leadCount = 0
  prisma = createFakePrisma(spec())
  installPrisma(prisma)
  server = await startTestServer('/api/ingest', ingestRouter)
})

afterEach(async () => {
  await server.close()
  resetPrisma()
})

function ingest(body: unknown, key: string | null = API_KEY) {
  return server.request('/api/ingest', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { 'x-api-key': key } : {}),
    },
    body: JSON.stringify(body),
  })
}

// --- API-key auth ---

test('rejects a missing API key', async () => {
  const res = await ingest({ leads: [{ businessName: 'A' }] }, null)
  assert.equal(res.status, 401)
})

test('rejects an invalid API key', async () => {
  const res = await ingest({ leads: [{ businessName: 'A' }] }, 'nope')
  assert.equal(res.status, 401)
})

// --- validation / caps ---

test('rejects an empty leads array', async () => {
  const res = await ingest({ leads: [] })
  assert.equal(res.status, 400)
})

test('rejects a batch larger than 500', async () => {
  const leads = Array.from({ length: 501 }, (_, i) => ({ businessName: `B${i}` }))
  const res = await ingest({ leads, autoResearch: false })
  assert.equal(res.status, 400)
})

test('rejects an unknown campaignId for the workspace', async () => {
  const res = await ingest({ leads: [{ businessName: 'A' }], campaignId: 'other-camp', autoResearch: false })
  assert.equal(res.status, 400)
})

// --- dedup ---

test('skips leads without a businessName', async () => {
  const res = await ingest({
    leads: [{ businessName: 'Keep' }, { email: 'no-name@x.test' }, { businessName: '   ' }],
    autoResearch: false,
  })
  assert.equal(res.status, 201)
  assert.equal(res.body.created, 1)
  assert.equal(res.body.skipped, 2)
})

test('deduplicates emails within the batch (first occurrence wins)', async () => {
  const res = await ingest({
    leads: [
      { businessName: 'First', email: 'dup@x.test' },
      { businessName: 'Second', email: 'DUP@x.test' }, // same email, different case
    ],
    autoResearch: false,
  })
  assert.equal(res.status, 201)
  assert.equal(res.body.created, 1)
  assert.equal(prisma.callsTo('lead', 'create').length, 1)
})

test('skips emails that already exist in the workspace (case-insensitive)', async () => {
  existingEmails = ['taken@x.test']
  const res = await ingest({
    leads: [
      { businessName: 'Taken', email: 'Taken@X.test' },
      { businessName: 'Fresh', email: 'fresh@x.test' },
    ],
    autoResearch: false,
  })
  assert.equal(res.status, 201)
  assert.equal(res.body.created, 1)
})

// --- plan lead-cap enforcement (cannot be bypassed via ingest) ---

test('truncates a batch that would exceed the plan lead cap', async () => {
  // Free plan caps at 500 leads; the workspace already has 499, so only one of
  // the five fresh leads may be created — the rest are skipped, not silently
  // allowed past the cap.
  leadCount = 499
  const res = await ingest({
    leads: Array.from({ length: 5 }, (_, i) => ({ businessName: `Biz ${i}` })),
    autoResearch: false,
  })
  assert.equal(res.status, 201)
  assert.equal(res.body.created, 1)
  assert.equal(res.body.skipped, 4)
  assert.equal(prisma.callsTo('lead', 'create').length, 1)
})

test('creates nothing when the workspace is already at the cap', async () => {
  leadCount = 500
  const res = await ingest({
    leads: [{ businessName: 'Over' }, { businessName: 'Limit' }],
    autoResearch: false,
  })
  assert.equal(res.status, 201)
  assert.equal(res.body.created, 0)
  assert.equal(prisma.callsTo('lead', 'create').length, 0)
})

// --- key management (owner only) ---

test('key rotation is denied for a non-owner', async () => {
  const res = await server.request(`/api/ingest/keys/rotate?workspaceId=${WS}`, {
    method: 'POST',
    headers: { Authorization: bearer(NON_OWNER) },
  })
  assert.equal(res.status, 403)
  assert.equal(prisma.callsTo('workspace', 'update').length, 0)
})

test('key rotation succeeds for the owner and returns a new key', async () => {
  const res = await server.request(`/api/ingest/keys/rotate?workspaceId=${WS}`, {
    method: 'POST',
    headers: { Authorization: bearer(OWNER) },
  })
  assert.equal(res.status, 200)
  assert.match(res.body.ingestApiKey, /^[a-f0-9]{64}$/)
  assert.equal(prisma.callsTo('workspace', 'update').length, 1)
})

test('key deletion is denied for a non-owner', async () => {
  const res = await server.request(`/api/ingest/keys?workspaceId=${WS}`, {
    method: 'DELETE',
    headers: { Authorization: bearer(NON_OWNER) },
  })
  assert.equal(res.status, 403)
})

test('key deletion looks up the existing key (to evict it) and clears it', async () => {
  const res = await server.request(`/api/ingest/keys?workspaceId=${WS}`, {
    method: 'DELETE',
    headers: { Authorization: bearer(OWNER) },
  })
  assert.equal(res.status, 200)
  // The pre-delete lookup that feeds cache eviction must have run...
  const lookups = prisma.callsTo('workspace', 'findUnique')
    .filter((c) => (c.args[0] as any)?.select?.ingestApiKey)
  assert.equal(lookups.length, 1)
  // ...and the key is nulled out.
  const update = prisma.callsTo('workspace', 'update')[0]
  assert.equal((update.args[0] as any).data.ingestApiKey, null)
})
