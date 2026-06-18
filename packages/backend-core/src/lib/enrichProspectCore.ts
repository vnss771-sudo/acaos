// Per-prospect enrichment core — the single implementation behind both the
// on-demand single-prospect route (apps/api: POST /api/prospects/:id/enrich) and
// the worker's batch job (enrich-prospects). Lives in backend-core so the worker
// can call it without depending on apps/api.
//
// Pipeline (adapted from a parallel-fan-out reference): the two independent
// provider calls — Apollo org-enrich and Hunter domain-search — run in PARALLEL;
// the discovered email is then verified before we treat it as sendable; finally
// the prospect is rescored from its full signal set. Per-prospect faults are the
// caller's concern (the batch processor isolates them with allSettled).

import { prisma } from './prisma.js'
import {
  calculateOpportunityScores,
  detectBuyingStage,
  calcWinProbability,
  toRawSignal,
  type ICPConfig,
  type SignalType,
} from './signalEngine.js'
import { ingestSignal } from './signalIngest.js'
import { CircuitOpenError } from './circuit.js'
import { recordAudit } from './audit.js'
import { enrichProspect } from '../services/apollo.js'
import { findContactEmail, verifyEmail, isHunterConfigured } from '../services/hunter.js'

export type EnrichCoreResult = {
  prospectId: string
  signalsCreated: number
  signalIds: string[]
  emailBackfilled: boolean
  skipped?: 'example' | 'not-found'
}

// Canonical ICP loader, mirroring the route's getICP (null → undefined shaping).
async function loadICP(workspaceId: string): Promise<ICPConfig | undefined> {
  const icp = await prisma.workspaceICP.findUnique({ where: { workspaceId } })
  if (!icp) return undefined
  return {
    targetIndustries: icp.targetIndustries,
    minEmployees:     icp.minEmployees ?? undefined,
    maxEmployees:     icp.maxEmployees ?? undefined,
    targetGeos:       icp.targetGeos,
    mustHaveEmail:    icp.mustHaveEmail,
  }
}

/**
 * Enrich a single prospect: Apollo firmographics/signals + Hunter contact email
 * (verified) + rescore. Idempotent at the signal layer (ingestSignal upserts by
 * fingerprint). Returns `skipped` for example/missing prospects rather than
 * throwing — the route layer owns the 404/403/isExample HTTP responses.
 */
export async function enrichProspectCore(prospectId: string): Promise<EnrichCoreResult> {
  const empty = (skipped?: 'example' | 'not-found'): EnrichCoreResult =>
    ({ prospectId, signalsCreated: 0, signalIds: [], emailBackfilled: false, skipped })

  const prospect = await prisma.prospect.findUnique({ where: { id: prospectId } })
  if (!prospect) return empty('not-found')
  if (prospect.isExample) return empty('example')

  // Independent provider calls in parallel. Both self-guard (enrichProspect is
  // wrapped in apolloBreaker; findContactEmail swallows its own errors). We also
  // tolerate an OPEN Apollo circuit so a tripped breaker degrades to "no Apollo
  // signals" rather than failing the whole enrichment.
  const wantHunter = Boolean(prospect.domain) && !prospect.contactEmail && isHunterConfigured()
  const [apollo, hunterContact] = await Promise.all([
    enrichProspect(prospect).catch((e) => {
      if (e instanceof CircuitOpenError) return { signals: [], updates: {} as Record<string, unknown> }
      throw e
    }),
    wantHunter ? findContactEmail(prospect.domain!).catch(() => null) : Promise.resolve(null),
  ])

  // Persist Apollo-detected signals with provenance (EvidenceSource).
  const signalIds: string[] = []
  for (const sig of apollo.signals) {
    const s = await ingestSignal({
      workspaceId:       prospect.workspaceId,
      prospectId:        prospect.id,
      type:              sig.type as SignalType,
      strength:          sig.strength,
      sourceReliability: sig.sourceReliability,
      industryRelevance: sig.industryRelevance,
      title:             sig.title,
      description:       sig.description,
      source:            sig.source,
      detectedAt:        sig.detectedAt,
      evidence: {
        provider:   sig.source,
        sourceType: 'enrichment',
        confidence: Math.max(0, Math.min(1, sig.sourceReliability / 100)),
        observedAt: sig.detectedAt,
      },
    })
    signalIds.push(s.id)
  }

  const updates: Record<string, unknown> = { ...apollo.updates }

  // Hunter contact backfill — only when the prospect had a domain and no email and
  // Apollo didn't already provide one (precedence guard: Apollo doesn't backfill
  // email today, but guard so a future change isn't clobbered). Gate the write on
  // verification: suppress ONLY a definitive 'undeliverable' verdict; "no
  // verification" (Hunter down/unconfigured) or 'risky' still writes — matching
  // ACAOS's best-effort enrichment posture. Email verification is recorded as
  // audit metadata, NOT as a scored Signal (it is data quality, not buying intent).
  let emailBackfilled = false
  if (hunterContact?.email && !prospect.contactEmail && !updates.contactEmail) {
    const verification = await verifyEmail(hunterContact.email)
    const undeliverable = verification?.result === 'undeliverable'
    if (!undeliverable) {
      updates.contactEmail = hunterContact.email
      emailBackfilled = true
      if (hunterContact.firstName && !prospect.contactName) {
        updates.contactName = [hunterContact.firstName, hunterContact.lastName].filter(Boolean).join(' ')
      }
      if (hunterContact.position && !prospect.contactTitle) {
        updates.contactTitle = hunterContact.position
      }
    }
    void recordAudit({
      workspaceId: prospect.workspaceId,
      type:        'prospect.email.verified',
      entityType:  'prospect',
      entityId:    prospect.id,
      metadata: {
        email:   hunterContact.email,
        result:  verification?.result ?? 'unverified',
        score:   verification?.score ?? null,
        written: !undeliverable,
      },
    })
  }

  // Rescore from the full signal set + ICP. Unlike the pre-refactor route (which
  // scored before the Hunter backfill and so persisted a score that ignored the
  // just-found email), scoring here reflects the final field set — more correct,
  // and the periodic rescore would have converged to this anyway.
  const [allSignals, icp] = await Promise.all([
    prisma.signal.findMany({ where: { prospectId: prospect.id } }),
    loadICP(prospect.workspaceId),
  ])
  const rawSignals = allSignals.map(toRawSignal)
  const scores = calculateOpportunityScores(rawSignals, {
    industry:      (updates.industry      as string | null | undefined) ?? prospect.industry,
    employeeCount: (updates.employeeCount as number | null | undefined) ?? prospect.employeeCount,
    contactEmail:  (updates.contactEmail  as string | null | undefined) ?? prospect.contactEmail,
    contactName:   (updates.contactName   as string | null | undefined) ?? prospect.contactName,
    domain:        (updates.domain        as string | null | undefined) ?? prospect.domain,
    location:      prospect.location,
  }, icp)
  const buyingStage    = detectBuyingStage(rawSignals, scores.opportunityScore)
  const winProbability = calcWinProbability(buyingStage, scores.opportunityScore)

  const latestSignalAt = (allSignals as Array<{ detectedAt: Date }>).reduce<Date | null>(
    (max, s) => (!max || s.detectedAt > max ? s.detectedAt : max),
    null,
  )

  await prisma.prospect.update({
    where: { id: prospect.id },
    data: {
      ...scores,
      buyingStage,
      winProbability,
      ...(latestSignalAt && { lastSignalAt: latestSignalAt }),
      ...(Object.keys(updates).length > 0 && updates),
    },
  })

  return { prospectId: prospect.id, signalsCreated: signalIds.length, signalIds, emailBackfilled }
}
