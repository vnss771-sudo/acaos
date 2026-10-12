// Persisting a Lead's research evidence as auditable, queryable rows — the
// relational counterpart to the prospect-track signalIngest/EvidenceSource path,
// scoped to a Lead. Lives in lib so the worker (and routes) can share it.
//
// The aiIntelligence JSON on the lead remains the point-in-time SNAPSHOT; these
// rows are the normalized provenance store (mirroring how the prospect side keeps
// both an evidenceSnapshot JSON and EvidenceSource rows).
import type { Prisma } from '@prisma/client'
import type { EvidenceItem } from './aiSchemas.js'
import { isWellFormedHttpUrl, urlHostnameMatchesDomain } from './normalize.js'

const EVIDENCE_TYPES = new Set(['confirmed', 'observed', 'inferred'])
const CONFIDENCE_LEVELS = new Set(['low', 'medium', 'high'])

export type LeadEvidenceRowInput = {
  evidenceType: string
  confidence: string
  signal: string
  provider: string
  sourceType: string
  sourceUrl: string | null
}

// sourceType is DERIVED from provenance strength, never taken from a model-supplied
// string — so the rows stay self-describing and trustworthy.
function sourceTypeFor(evidenceType: string, hasUrl: boolean): string {
  if (evidenceType === 'confirmed') return hasUrl ? 'website' : 'external'
  if (evidenceType === 'observed') return 'notes'
  return 'inference'
}

/**
 * "confirmed" means a source was actually read. Research does not yet fetch the
 * website, so a model-supplied "confirmed" is unverifiable: downgrade every
 * confirmed item to "inferred" (dropping its sourceUrl) unless fetched content
 * was supplied for that URL's host. Pure.
 */
export function downgradeUnverifiedEvidence(
  evidence: EvidenceItem[] | undefined | null,
  fetchedUrls: readonly string[] = [],
): EvidenceItem[] {
  if (!Array.isArray(evidence)) return []
  return evidence.map((e) => {
    if (e.type !== 'confirmed') return e
    const verified = typeof e.sourceUrl === 'string' && fetchedUrls.some((u) => urlHostnameMatchesDomain(e.sourceUrl as string, u))
    if (verified) return e
    const { sourceUrl: _drop, ...rest } = e
    return { ...rest, type: 'inferred' } as EvidenceItem
  })
}

/**
 * Map validated research evidence items to LeadEvidenceSource row inputs. Pure.
 * Unknown/missing type or confidence degrade to the weakest tier (inferred/low) so
 * a drifting field never lets a guess masquerade as a confirmed fact; a sourceUrl
 * is kept only for `confirmed` items (provenance must be real to be cited), and
 * only when it's a well-formed http(s) URL. When `referenceWebsite` (the lead's
 * own website) is known, a sourceUrl whose hostname is unrelated to it is dropped
 * too — a "confirmed" claim citing a completely different company's domain is a
 * hallucinated/mismatched citation, not real provenance, even though the
 * underlying observation may still be worth keeping at face value.
 */
export function mapEvidenceToRows(
  evidence: EvidenceItem[] | undefined | null,
  referenceWebsite?: string | null,
): LeadEvidenceRowInput[] {
  if (!Array.isArray(evidence)) return []
  return evidence
    .filter((e) => e && typeof e.signal === 'string' && e.signal.trim().length > 0)
    .slice(0, 20)
    .map((e) => {
      const evidenceType = EVIDENCE_TYPES.has(e.type) ? e.type : 'inferred'
      const confidence = CONFIDENCE_LEVELS.has(e.confidence) ? e.confidence : 'low'
      const rawUrl = evidenceType === 'confirmed' && typeof e.sourceUrl === 'string' ? e.sourceUrl.trim() : ''
      const domainOk = !referenceWebsite || !rawUrl || urlHostnameMatchesDomain(rawUrl, referenceWebsite)
      const sourceUrl = rawUrl && isWellFormedHttpUrl(rawUrl) && domainOk
        ? rawUrl.slice(0, 2000)
        : null
      return {
        evidenceType,
        confidence,
        signal: e.signal.trim().slice(0, 500),
        provider: 'llm-research',
        sourceType: sourceTypeFor(evidenceType, !!sourceUrl),
        sourceUrl,
      }
    })
}

/**
 * Replace a lead's evidence rows with a fresh set. Re-research is idempotent: the
 * lead's existing rows are cleared first, then the new ones inserted. Pass a
 * transaction client to make this atomic with the lead update. Returns the count.
 */
export async function replaceLeadEvidence(
  db: Prisma.TransactionClient,
  input: { workspaceId: string; leadId: string; evidence: EvidenceItem[] | undefined | null; website?: string | null },
): Promise<number> {
  const rows = mapEvidenceToRows(input.evidence, input.website)
  await db.leadEvidenceSource.deleteMany({ where: { leadId: input.leadId } })
  if (rows.length === 0) return 0
  await db.leadEvidenceSource.createMany({
    data: rows.map((r) => ({ ...r, workspaceId: input.workspaceId, leadId: input.leadId })),
  })
  return rows.length
}
