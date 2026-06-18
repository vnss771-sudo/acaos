// Unit tests for the shared per-prospect enrichment core (Apollo + Hunter →
// signals + verified contact → rescore). Fake Prisma + a URL-routing fetch stub;
// no network, no Redis.

import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createFakePrisma, installPrisma, resetPrisma, type FakePrisma } from './helpers/integration.ts'
import { enrichProspectCore } from '../apps/api/src/lib/enrichProspectCore.ts'

const origFetch = globalThis.fetch
const origApollo = process.env.APOLLO_API_KEY
const origHunter = process.env.HUNTER_API_KEY

afterEach(() => {
  globalThis.fetch = origFetch
  resetPrisma()
  if (origApollo === undefined) delete process.env.APOLLO_API_KEY; else process.env.APOLLO_API_KEY = origApollo
  if (origHunter === undefined) delete process.env.HUNTER_API_KEY; else process.env.HUNTER_API_KEY = origHunter
})

// Route the stubbed fetch by URL so Apollo enrich, Hunter domain-search and Hunter
// verify can return distinct payloads. Records every URL hit for assertions.
function routeFetch(hits: string[], handlers: {
  apollo?: unknown
  domainSearch?: unknown
  verify?: unknown
}) {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input)
    hits.push(url)
    let payload: unknown = {}
    if (url.includes('organizations/enrich')) payload = handlers.apollo ?? { organization: null }
    else if (url.includes('domain-search')) payload = handlers.domainSearch ?? { data: { emails: [] } }
    else if (url.includes('email-verifier')) payload = handlers.verify ?? { data: { result: 'unknown', score: 0 } }
    return { ok: true, json: async () => payload }
  }) as unknown as typeof fetch
}

function prospect(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1', workspaceId: 'ws1', companyName: 'Acme', domain: 'acme.test',
    industry: null, employeeCount: null, contactEmail: null, contactName: null,
    contactTitle: null, location: 'NYC', opportunityScore: 0, isExample: false,
    ...overrides,
  }
}

function coreSpec(p: Record<string, unknown> | null) {
  return {
    prospect: {
      findUnique: async () => p,
      update: async (a: any) => ({ ...(p ?? {}), ...a.data }),
    },
    evidenceSource: { create: async () => ({ id: 'ev1' }) },
    signal: {
      upsert: async (a: any) => ({ id: `sig-${a?.create?.type ?? 'x'}` }),
      findMany: async () => [],
    },
    workspaceICP: { findUnique: async () => null },
    auditEvent: { create: async () => ({ id: 'a1' }) },
  }
}

test('ingests Apollo signals and backfills a verified Hunter email (both providers fire)', async () => {
  process.env.APOLLO_API_KEY = 'a'
  process.env.HUNTER_API_KEY = 'h'
  const prisma = createFakePrisma(coreSpec(prospect())) as FakePrisma
  installPrisma(prisma)

  const hits: string[] = []
  routeFetch(hits, {
    apollo: { organization: { current_jobs_count: 5, estimated_num_employees: 40, industry: 'construction' } },
    domainSearch: { data: { emails: [{ value: 'ceo@acme.test', confidence: 90, first_name: 'Cee', last_name: 'Oh', position: 'CEO' }] } },
    verify: { data: { result: 'deliverable', score: 95 } },
  })

  const res = await enrichProspectCore('p1')

  assert.equal(res.skipped, undefined)
  assert.equal(res.signalsCreated, 1, 'HIRING signal ingested')
  assert.equal(res.emailBackfilled, true)
  assert.ok(hits.some(u => u.includes('organizations/enrich')), 'Apollo enrich called')
  assert.ok(hits.some(u => u.includes('domain-search')), 'Hunter domain-search called')
  assert.ok(hits.some(u => u.includes('email-verifier')), 'Hunter verify called')

  const update = prisma.callsTo('prospect', 'update')[0].args[0] as any
  assert.equal(update.data.contactEmail, 'ceo@acme.test')
  assert.equal(update.data.contactName, 'Cee Oh')
  assert.equal(update.data.contactTitle, 'CEO')
})

test('does NOT write an email that verification reports undeliverable', async () => {
  process.env.APOLLO_API_KEY = 'a'
  process.env.HUNTER_API_KEY = 'h'
  const prisma = createFakePrisma(coreSpec(prospect())) as FakePrisma
  installPrisma(prisma)

  routeFetch([], {
    apollo: { organization: null },
    domainSearch: { data: { emails: [{ value: 'bounce@acme.test', confidence: 80 }] } },
    verify: { data: { result: 'undeliverable', score: 0 } },
  })

  const res = await enrichProspectCore('p1')
  assert.equal(res.emailBackfilled, false)
  const update = prisma.callsTo('prospect', 'update')[0].args[0] as any
  assert.equal(update.data.contactEmail, undefined, 'undeliverable email not persisted')
})

test('skips Hunter entirely when the prospect already has an email', async () => {
  process.env.APOLLO_API_KEY = 'a'
  process.env.HUNTER_API_KEY = 'h'
  installPrisma(createFakePrisma(coreSpec(prospect({ contactEmail: 'existing@acme.test' }))) as FakePrisma)

  const hits: string[] = []
  routeFetch(hits, { apollo: { organization: null } })

  const res = await enrichProspectCore('p1')
  assert.equal(res.emailBackfilled, false)
  assert.ok(!hits.some(u => u.includes('domain-search')), 'Hunter not consulted when email present')
})

test('short-circuits example prospects without touching providers', async () => {
  process.env.APOLLO_API_KEY = 'a'
  const prisma = createFakePrisma(coreSpec(prospect({ isExample: true }))) as FakePrisma
  installPrisma(prisma)
  const hits: string[] = []
  routeFetch(hits, {})

  const res = await enrichProspectCore('p1')
  assert.equal(res.skipped, 'example')
  assert.equal(hits.length, 0)
  assert.equal(prisma.callsTo('prospect', 'update').length, 0)
})

test('returns not-found for a missing prospect', async () => {
  installPrisma(createFakePrisma(coreSpec(null)) as FakePrisma)
  const res = await enrichProspectCore('nope')
  assert.equal(res.skipped, 'not-found')
})
