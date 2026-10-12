// E3.4b against a real database: operational guards around website evidence collection.
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { prisma, resetDb, disconnect, seedUserWithWorkspace } from './helpers/db.ts'
import { processWebsiteEvidence } from '../apps/worker/src/processors/websiteEvidence.ts'
import type { WebsiteDocument } from '../packages/backend-core/src/lib/websiteEvidenceFetch.ts'

after(async () => { await disconnect() })
beforeEach(async () => { await resetDb(); delete process.env.WEBSITE_EVIDENCE_DAILY_LIMIT; process.env.WEBSITE_EVIDENCE_ENABLED = 'true' })

const PAGE = '<p>We install and maintain commercial electrical systems across Brisbane.</p>'
function deps() {
  const fetched: string[] = []
  return {
    fetched,
    d: {
      sleep: async () => {},
      fetchDoc: async (url: string): Promise<WebsiteDocument> => {
        fetched.push(url)
        const { WebsiteFetchError } = await import('../packages/backend-core/src/lib/websiteEvidenceFetch.ts')
        if (url.endsWith('/robots.txt')) throw new WebsiteFetchError('upstream_status', 404)
        return { sourceUrl: url, retrievedAt: new Date().toISOString(), contentType: 'text/html', text: PAGE, bytes: PAGE.length, redirects: 0 }
      },
    },
  }
}
const mk = (workspaceId: string, domain: string | null) => prisma.prospect.create({ data: { workspaceId, companyName: 'Acme', domain } })

test('flag off: nothing fetched; missing prospect / no website short-circuit before any network', async () => {
  const { workspace } = await seedUserWithWorkspace('wj1@x.test')
  const p = await mk(workspace.id, 'acme.com.au'); const h = deps()
  process.env.WEBSITE_EVIDENCE_ENABLED = 'false'
  assert.deepEqual(await processWebsiteEvidence(workspace.id, p.id, h.d), { status: 'disabled' })
  process.env.WEBSITE_EVIDENCE_ENABLED = 'true'
  assert.equal((await processWebsiteEvidence(workspace.id, 'nope', h.d)).status, 'prospect_not_found')
  const noSite = await mk(workspace.id, null)
  assert.equal((await processWebsiteEvidence(workspace.id, noSite.id, h.d)).status, 'no_website')
  assert.equal(h.fetched.length, 0)
})

test('collects, audits counts only, then dedupes within 24 h (no repeated requests)', async () => {
  const { workspace } = await seedUserWithWorkspace('wj2@x.test')
  const p = await mk(workspace.id, 'acme.com.au'); const h = deps()
  const r = await processWebsiteEvidence(workspace.id, p.id, h.d)
  assert.equal(r.status, 'collected')
  assert.ok((await prisma.websiteEvidenceClaim.count({ where: { workspaceId: workspace.id } })) >= 1)
  const audit = await prisma.auditEvent.findFirst({ where: { workspaceId: workspace.id, type: 'website_evidence.collected' } })
  assert.ok(audit && !JSON.stringify(audit.metadata).includes('electrical'), 'audit carries outcomes, not page text')
  const calls = h.fetched.length
  assert.equal((await processWebsiteEvidence(workspace.id, p.id, h.d)).status, 'recently_collected')
  assert.equal(h.fetched.length, calls, 'second run made no network requests')
  assert.equal(await prisma.consentRecord.count({ where: { workspaceId: workspace.id } }), 0)
})

test('daily cap is per workspace and audited; another workspace is unaffected; cross-tenant prospect refused', async () => {
  process.env.WEBSITE_EVIDENCE_DAILY_LIMIT = '1'
  const a = await seedUserWithWorkspace('wj3a@x.test'); const b = await seedUserWithWorkspace('wj3b@x.test')
  const pa1 = await mk(a.workspace.id, 'one.com.au'); const pa2 = await mk(a.workspace.id, 'two.com.au'); const pb = await mk(b.workspace.id, 'three.com.au')
  const h = deps()
  assert.equal((await processWebsiteEvidence(a.workspace.id, pa1.id, h.d)).status, 'collected')
  assert.equal((await processWebsiteEvidence(a.workspace.id, pa2.id, h.d)).status, 'quota_exceeded')
  assert.ok(await prisma.auditEvent.findFirst({ where: { workspaceId: a.workspace.id, type: 'website_evidence.blocked' } }))
  assert.equal((await processWebsiteEvidence(b.workspace.id, pb.id, h.d)).status, 'collected')
  assert.equal((await processWebsiteEvidence(a.workspace.id, pb.id, h.d)).status, 'prospect_not_found')
})
