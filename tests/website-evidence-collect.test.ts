import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { parseRobots, isPathAllowed, collectProspectEvidence, MIN_REQUEST_SPACING_MS } from '../packages/backend-core/src/lib/websiteEvidenceCollect.ts'
import { WebsiteFetchError, type WebsiteDocument } from '../packages/backend-core/src/lib/websiteEvidenceFetch.ts'

const saved = process.env.WEBSITE_EVIDENCE_ENABLED
afterEach(() => { if (saved === undefined) delete process.env.WEBSITE_EVIDENCE_ENABLED; else process.env.WEBSITE_EVIDENCE_ENABLED = saved })

const doc = (url: string, text: string): WebsiteDocument => ({ sourceUrl: url, retrievedAt: new Date().toISOString(), contentType: 'text/html', text, bytes: text.length, redirects: 0 })
const PAGE = '<p>We install and maintain commercial electrical systems across Brisbane.</p>'
function fakeDb() {
  const upserts: unknown[] = []
  const db = { prospect: { findFirst: async () => ({ id: 'p1' }) }, websiteEvidenceClaim: { upsert: async (a: unknown) => { upserts.push(a) } } }
  return { db: db as never, upserts }
}
function harness(robots: string | WebsiteFetchError, pages: Record<string, string | WebsiteFetchError> = {}) {
  const fetched: string[] = []; const sleeps: number[] = []
  return {
    fetched, sleeps,
    deps: {
      sleep: async (ms: number) => { sleeps.push(ms) },
      fetchDoc: async (url: string) => {
        fetched.push(url)
        const v = url.endsWith('/robots.txt') ? robots : (pages[new URL(url).pathname] ?? PAGE)
        if (v instanceof Error) throw v
        return doc(url, v)
      },
    },
  }
}
const input = { workspaceId: 'w1', prospectId: 'p1', website: 'https://acme.com.au' }

test('robots parsing: our UA group beats *, longest match wins, Allow wins ties', () => {
  const r = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: ACAOS-EvidenceFetcher\nDisallow: /private\nAllow: /private/ok\n')
  assert.equal(isPathAllowed(r, '/about'), true)
  assert.equal(isPathAllowed(r, '/private/x'), false)
  assert.equal(isPathAllowed(r, '/private/ok'), true)
  assert.equal(isPathAllowed(parseRobots('User-agent: *\nDisallow: /\n'), '/'), false)
  assert.equal(isPathAllowed(parseRobots('User-agent: *\nDisallow:\n'), '/'), true)
  assert.equal(isPathAllowed(parseRobots('User-agent: *\nDisallow: /*.pdf$\n'), '/a.pdf'), false)
})

test('flag off (default): nothing is fetched or stored', async () => {
  delete process.env.WEBSITE_EVIDENCE_ENABLED
  const h = harness(''); const { db, upserts } = fakeDb()
  assert.deepEqual(await collectProspectEvidence(db, input, h.deps), { status: 'disabled' })
  assert.equal(h.fetched.length, 0); assert.equal(upserts.length, 0)
})

test('robots: unreadable (5xx/403/network) or fully disallowing => fail closed, no pages fetched', async () => {
  process.env.WEBSITE_EVIDENCE_ENABLED = 'true'
  for (const e of [new WebsiteFetchError('upstream_status', 500), new WebsiteFetchError('upstream_status', 403), new WebsiteFetchError('network_failure')]) {
    const h = harness(e); const { db } = fakeDb()
    assert.equal((await collectProspectEvidence(db, input, h.deps)).status, 'robots_unavailable')
    assert.deepEqual(h.fetched, ['https://acme.com.au/robots.txt'])
  }
  const h = harness('User-agent: *\nDisallow: /\n'); const { db } = fakeDb()
  assert.equal((await collectProspectEvidence(db, input, h.deps)).status, 'robots_disallows_all')
  assert.equal(h.fetched.length, 1)
})

test('robots 404 => allowed; at most 3 fixed paths, spaced >= 5s, disallowed paths skipped', async () => {
  process.env.WEBSITE_EVIDENCE_ENABLED = 'true'
  const h = harness(new WebsiteFetchError('upstream_status', 404)); const { db, upserts } = fakeDb()
  const r = await collectProspectEvidence(db, input, h.deps)
  assert.equal(r.status, 'ok')
  assert.deepEqual(h.fetched, ['https://acme.com.au/robots.txt', 'https://acme.com.au/', 'https://acme.com.au/about', 'https://acme.com.au/contact'])
  assert.deepEqual(h.sleeps, [MIN_REQUEST_SPACING_MS, MIN_REQUEST_SPACING_MS])
  assert.ok(upserts.length >= 1)

  const h2 = harness('User-agent: *\nDisallow: /about\n'); const d2 = fakeDb()
  const r2 = await collectProspectEvidence(d2.db, input, h2.deps)
  assert.equal(r2.status === 'ok' && r2.pages.find((p) => p.path === '/about')?.outcome, 'robots_disallowed')
  assert.ok(!h2.fetched.some((u) => u.endsWith('/about')))
})

test('one failing page does not abort the others; ownership errors are not swallowed; http and junk sites rejected', async () => {
  process.env.WEBSITE_EVIDENCE_ENABLED = 'true'
  const h = harness('', { '/about': new WebsiteFetchError('timeout') }); const { db } = fakeDb()
  const r = await collectProspectEvidence(db, input, h.deps)
  assert.ok(r.status === 'ok' && r.pages.some((p) => p.outcome === 'fetch_failed' && p.reason === 'timeout') && r.claimsSaved >= 1)
  const bad = { prospect: { findFirst: async () => null }, websiteEvidenceClaim: { upsert: async () => {} } } as never
  await assert.rejects(collectProspectEvidence(bad, input, harness('').deps), /prospect_not_found_in_workspace/)
  for (const w of ['http://acme.com.au', 'ftp://x.com', '://']) assert.equal((await collectProspectEvidence(db, { ...input, website: w }, harness('').deps)).status, 'invalid_website')
})
