import test from 'node:test'
import assert from 'node:assert/strict'
import { extractWebsiteEvidence } from '../packages/backend-core/src/lib/websiteEvidenceExtract.js'
import { saveWebsiteEvidence, listWebsiteEvidence, pruneExpiredWebsiteEvidence } from '../packages/backend-core/src/lib/websiteEvidenceStore.js'
import type { WebsiteDocument } from '../packages/backend-core/src/lib/websiteEvidenceFetch.js'

const doc: WebsiteDocument = { sourceUrl: 'https://example.org/about', retrievedAt: '2026-10-12T00:00:00Z', contentType: 'text/plain', text: 'We provide commercial electrical installation and maintenance services across Brisbane.', bytes: 86, redirects: 0 }
const extraction = extractWebsiteEvidence(doc)
const now = new Date('2026-10-12T12:00:00Z')
const makeDb = (owner = true) => {
  const rows = new Map<string, any>()
  const db: any = {
    prospect: { findFirst: async ({ where }: any) => owner && where.workspaceId === 'w1' && where.id === 'p1' ? { id: 'p1' } : null },
    websiteEvidenceClaim: {
      upsert: async ({ where, create, update }: any) => {
        const key = JSON.stringify(where.workspaceId_prospectId_claimId)
        rows.set(key, rows.has(key) ? { ...rows.get(key), ...update } : { ...create, id: key })
      },
      findMany: async ({ where, take }: any) => [...rows.values()].filter((r: any) => where.expiresAt?.gt ? r.workspaceId === where.workspaceId && r.prospectId === where.prospectId && r.expiresAt > where.expiresAt.gt : r.expiresAt <= where.expiresAt.lte).slice(0, take),
      deleteMany: async ({ where }: any) => { let n = 0; for (const [key, value] of rows) if (where.id.in.includes(value.id) && value.expiresAt <= where.expiresAt.lte) { rows.delete(key); n++ } return { count: n } },
    },
  }
  return { db, rows }
}

test('tenant ownership required before any write', async () => {
  const { db, rows } = makeDb(false)
  await assert.rejects(saveWebsiteEvidence(db, { workspaceId: 'w2', prospectId: 'p1', extraction }, now), /prospect_not_found/)
  assert.equal(rows.size, 0)
})
test('idempotent upsert and tenant-scoped read with expiry', async () => {
  const { db, rows } = makeDb()
  const input = { workspaceId: 'w1', prospectId: 'p1', extraction }
  assert.equal(await saveWebsiteEvidence(db, input, now), 1)
  assert.equal(await saveWebsiteEvidence(db, input, now), 1)
  assert.equal(rows.size, 1)
  assert.equal((await listWebsiteEvidence(db, 'w1', 'p1', now)).length, 1)
  assert.equal((await listWebsiteEvidence(db, 'w2', 'p1', now)).length, 0)
  assert.equal((await listWebsiteEvidence(db, 'w1', 'p1', new Date('2027-02-01'))).length, 0)
})
test('fails closed for forged source contract or excessive retention', async () => {
  const { db, rows } = makeDb()
  await assert.rejects(saveWebsiteEvidence(db, { workspaceId: 'w1', prospectId: 'p1', extraction: { ...extraction, warning: 'other' as any } }, now))
  await assert.rejects(saveWebsiteEvidence(db, { workspaceId: 'w1', prospectId: 'p1', extraction, retentionDays: 365 }, now))
  assert.equal(rows.size, 0)
})
test('bounded prune deletes expired rows only', async () => {
  const { db } = makeDb()
  await saveWebsiteEvidence(db, { workspaceId: 'w1', prospectId: 'p1', extraction, retentionDays: 1 }, now)
  assert.equal(await pruneExpiredWebsiteEvidence(db, now), 0)
  assert.equal(await pruneExpiredWebsiteEvidence(db, new Date('2026-10-15')), 1)
  assert.equal(await pruneExpiredWebsiteEvidence(db, new Date('2026-10-15')), 0)
})
