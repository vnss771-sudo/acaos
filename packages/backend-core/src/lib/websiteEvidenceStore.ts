/** E3.3: tenant-bound website evidence only. Never creates Signals, ConsentRecords or sends. */
import type { Prisma } from '@prisma/client'
import type { WebsiteEvidenceExtraction } from './websiteEvidenceExtract.js'

const MAX_CLAIMS = 20
const MAX_QUOTE = 360
const MAX_RETENTION_DAYS = 90

type DB = Pick<Prisma.TransactionClient, 'prospect' | 'websiteEvidenceClaim'>

export type WebsiteEvidenceSaveInput = Readonly<{
  workspaceId: string
  prospectId: string
  extraction: WebsiteEvidenceExtraction
  retentionDays?: number
}>

/** Calls must run inside the caller's transaction to bind prospect ownership and writes. */
export async function saveWebsiteEvidence(db: DB, input: WebsiteEvidenceSaveInput, now = new Date()): Promise<number> {
  const { workspaceId, prospectId, extraction } = input
  if (!workspaceId || !prospectId) throw new Error('missing_scope')
  const owner = await db.prospect.findFirst({ where: { id: prospectId, workspaceId }, select: { id: true } })
  if (!owner) throw new Error('prospect_not_found_in_workspace')
  if (extraction.warning !== 'web_content_untrusted_not_consent') throw new Error('untrusted_evidence_contract')
  const parsed = new URL(extraction.sourceUrl)
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('invalid_source_url')
  if (!/^[a-f0-9]{64}$/.test(extraction.sourceHash)) throw new Error('invalid_source_hash')
  const retention = input.retentionDays ?? 30
  if (!Number.isSafeInteger(retention) || retention < 1 || retention > MAX_RETENTION_DAYS) throw new Error('invalid_retention')
  const capturedAt = new Date(extraction.capturedAt)
  if (!Number.isFinite(capturedAt.getTime()) || capturedAt.getTime() > now.getTime() + 60_000) throw new Error('invalid_capture_time')
  const expiresAt = new Date(now.getTime() + retention * 86_400_000)
  const claims = extraction.claims.slice(0, MAX_CLAIMS)
  const seen = new Set<string>()
  for (const claim of claims) {
    if (claim.verification !== 'source_observed' || claim.confidence !== 'unverified' ||
        claim.sourceUrl !== extraction.sourceUrl || claim.sourceHash !== extraction.sourceHash ||
        claim.capturedAt !== extraction.capturedAt || !/^[a-f0-9]{64}$/.test(claim.id) ||
        !claim.quote.trim() || claim.quote.length > MAX_QUOTE ||
        !['service', 'project', 'contact', 'general'].includes(claim.category)) throw new Error('invalid_claim_contract')
    if (seen.has(claim.id)) continue
    seen.add(claim.id)
    await db.websiteEvidenceClaim.upsert({
      where: { workspaceId_prospectId_claimId: { workspaceId, prospectId, claimId: claim.id } },
      create: { workspaceId, prospectId, claimId: claim.id, sourceUrl: extraction.sourceUrl,
        sourceHash: extraction.sourceHash, quote: claim.quote, category: claim.category,
        capturedAt, lastSeenAt: now, expiresAt },
      update: { lastSeenAt: now, expiresAt },
    })
  }
  return seen.size
}

/** Tenant-scoped read: expired claims never appear in the customer-facing results. */
export async function listWebsiteEvidence(db: Pick<DB, 'websiteEvidenceClaim'>, workspaceId: string, prospectId: string, now = new Date()) {
  if (!workspaceId || !prospectId) throw new Error('missing_scope')
  return db.websiteEvidenceClaim.findMany({
    where: { workspaceId, prospectId, expiresAt: { gt: now } },
    orderBy: [{ capturedAt: 'desc' }, { id: 'asc' }], take: 100,
    select: { claimId: true, quote: true, category: true, sourceUrl: true, sourceHash: true, capturedAt: true, expiresAt: true },
  })
}

/** Scheduled cleanup: bounded deletes, idempotent, never modifies other evidence tables. */
export async function pruneExpiredWebsiteEvidence(db: Pick<DB, 'websiteEvidenceClaim'>, now = new Date(), limit = 500) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('invalid_limit')
  const expired = await db.websiteEvidenceClaim.findMany({
    where: { expiresAt: { lte: now } }, orderBy: { id: 'asc' }, take: limit, select: { id: true },
  })
  if (!expired.length) return 0
  const result = await db.websiteEvidenceClaim.deleteMany({ where: { id: { in: expired.map((e) => e.id) }, expiresAt: { lte: now } } })
  return result.count
}
