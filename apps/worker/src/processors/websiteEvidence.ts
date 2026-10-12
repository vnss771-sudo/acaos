/**
 * E3.4b: worker-side processor for website evidence (directly testable; NOT yet registered with a queue — see
 * docs/pilot/REMAINING_PHASES_PLAN.md E3.4c). Adds the operational guards around collectProspectEvidence:
 * kill switch, per-prospect 24 h dedupe (no repeated requests), per-workspace daily cap, content-free audit trail.
 * Creates no Signal, consent or send. Concurrency/global limits belong to the queue registration.
 */
import { prisma } from '@acaos/backend-core/lib/prisma.js'
import { recordAudit } from '@acaos/backend-core/lib/audit.js'
import { isWebsiteEvidenceEnabled } from '@acaos/backend-core/lib/launchControls.js'
import { collectProspectEvidence, type CollectDeps, type CollectResult } from '@acaos/backend-core/lib/websiteEvidenceCollect.js'

export const RECOLLECT_AFTER_MS = 24 * 60 * 60 * 1000
export const DEFAULT_DAILY_LIMIT = 50

export type WebsiteEvidenceJobResult =
  | { status: 'disabled' | 'prospect_not_found' | 'no_website' | 'recently_collected' | 'quota_exceeded' }
  | { status: 'collected'; result: CollectResult }

function dailyLimit(): number {
  const n = Number(process.env.WEBSITE_EVIDENCE_DAILY_LIMIT)
  return Number.isSafeInteger(n) && n >= 1 && n <= 1000 ? n : DEFAULT_DAILY_LIMIT
}

export async function processWebsiteEvidence(
  workspaceId: string,
  prospectId: string,
  deps: CollectDeps = {},
  now: Date = new Date(),
): Promise<WebsiteEvidenceJobResult> {
  if (!isWebsiteEvidenceEnabled()) return { status: 'disabled' }
  const prospect = await prisma.prospect.findFirst({ where: { id: prospectId, workspaceId }, select: { domain: true } })
  if (!prospect) return { status: 'prospect_not_found' }
  if (!prospect.domain?.trim()) return { status: 'no_website' }

  // Avoid unnecessary repeated requests to the same site.
  const recent = await prisma.websiteEvidenceClaim.findFirst({
    where: { workspaceId, prospectId, lastSeenAt: { gt: new Date(now.getTime() - RECOLLECT_AFTER_MS) } },
    select: { id: true },
  })
  if (recent) return { status: 'recently_collected' }

  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const used = await prisma.auditEvent.count({ where: { workspaceId, type: 'website_evidence.collected', createdAt: { gte: startOfDay } } })
  if (used >= dailyLimit()) {
    await recordAudit({ workspaceId, type: 'website_evidence.blocked', entityType: 'prospect', entityId: prospectId, metadata: { reason: 'daily_quota' } })
    return { status: 'quota_exceeded' }
  }

  // Network I/O runs outside any DB transaction (interactive transactions time out in seconds); the store re-checks
  // workspace ownership of the prospect on every write.
  const result = await collectProspectEvidence(prisma as unknown as Parameters<typeof collectProspectEvidence>[0], { workspaceId, prospectId, website: prospect.domain }, { ...deps, now: deps.now ?? (() => now) })
  await recordAudit({
    workspaceId, type: 'website_evidence.collected', entityType: 'prospect', entityId: prospectId,
    // Counts and outcomes only: never page text, quotes or URLs with secrets.
    metadata: result.status === 'ok'
      ? { status: 'ok', claimsSaved: result.claimsSaved, pages: result.pages.map((p) => ({ path: p.path, outcome: p.outcome })) }
      : { status: result.status },
  })
  return { status: 'collected', result }
}
