import { prisma } from './prisma.js'

// AI draft-quality metrics per prompt version. Now that every generated draft
// records which prompt/model produced it (promptVersionId, see aiPromptRegistry),
// we can correlate human/automatic outcomes — approved, rejected, flagged for
// policy review — back to the prompt version that generated them. This is the
// drift signal: a prompt or model change that quietly worsens copy shows up as a
// falling approval rate or a rising rejection / policy-review rate for its version.
//
// Read-only; reads existing OutreachDraft.status + promptVersionId. No schema change.

export type DraftStatusCounts = Record<string, number>

export interface PromptQualityRates {
  total: number
  // Of drafts a human/decision acted on (approved+sent vs rejected): the share kept.
  approvalRate: number
  rejectionRate: number
  // Of all drafts: the share auto-flagged for policy review.
  policyReviewRate: number
}

export interface PromptVersionQuality extends PromptQualityRates {
  promptVersionId: string
  type: string
  version: number
  model: string
  createdAt: Date
  byStatus: DraftStatusCounts
}

/**
 * Derive quality rates from a draft status-count map. Pure. APPROVED and SENT both
 * count as "kept"; REJECTED as "discarded"; the two together are the reviewed pool
 * for approval/rejection rates. POLICY_REVIEW is rated against all drafts.
 */
export function computePromptQualityRates(counts: DraftStatusCounts): PromptQualityRates {
  const get = (s: string) => counts[s] ?? 0
  const kept = get('APPROVED') + get('SENT')
  const rejected = get('REJECTED')
  const policyReview = get('POLICY_REVIEW')
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  const reviewed = kept + rejected
  return {
    total,
    approvalRate: reviewed > 0 ? kept / reviewed : 0,
    rejectionRate: reviewed > 0 ? rejected / reviewed : 0,
    policyReviewRate: total > 0 ? policyReview / total : 0,
  }
}

/**
 * Per-prompt-version draft-quality breakdown for a workspace, newest version first.
 * Aggregates OutreachDraft by (promptVersionId, status) and joins the prompt-version
 * metadata. Drafts with no recorded provenance are excluded.
 */
export async function promptVersionQuality(workspaceId: string): Promise<PromptVersionQuality[]> {
  const grouped = await prisma.outreachDraft.groupBy({
    by: ['promptVersionId', 'status'],
    where: { workspaceId, promptVersionId: { not: null } },
    _count: { _all: true },
  })

  const byVersion = new Map<string, DraftStatusCounts>()
  for (const g of grouped as Array<{ promptVersionId: string | null; status: string; _count: { _all: number } }>) {
    if (!g.promptVersionId) continue
    const counts = byVersion.get(g.promptVersionId) ?? {}
    counts[g.status] = g._count._all
    byVersion.set(g.promptVersionId, counts)
  }
  if (byVersion.size === 0) return []

  const versions = await prisma.aiPromptVersion.findMany({
    where: { id: { in: [...byVersion.keys()] } },
    select: { id: true, type: true, version: true, model: true, createdAt: true },
  })

  return (versions as Array<{ id: string; type: string; version: number; model: string; createdAt: Date }>)
    .map((v) => {
      const byStatus = byVersion.get(v.id) ?? {}
      return {
        promptVersionId: v.id,
        type: v.type,
        version: v.version,
        model: v.model,
        createdAt: v.createdAt,
        byStatus,
        ...computePromptQualityRates(byStatus),
      }
    })
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
}
