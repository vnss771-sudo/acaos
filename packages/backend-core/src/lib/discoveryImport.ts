// Shared candidate-import logic for prospect discovery. Extracted from the
// synchronous /discover route so the discover-prospects worker can run it
// off-request. Dedupes against existing prospects, creates new ones with
// computed scores, and seeds HIRING/FUNDING signals from the candidate payload.
//
// Per-candidate errors are caught and counted (skipped) so one bad row never
// aborts the batch; a fatal error (e.g. the DB going away) propagates to the
// caller, which records a PARTIAL run with the counts accumulated so far.
import { prisma } from './prisma.js'
import {
  calculateOpportunityScores,
  detectBuyingStage,
  calcWinProbability,
  type ICPConfig,
} from './signalEngine.js'
import { ingestSignal } from './signalIngest.js'
import { normalizeDomain, normalizeCompanyNameKey, normalizeEmailKey } from './normalize.js'
import type { ProspectCandidate } from './prospectSources.js'

export type ImportProgress = (imported: number, skipped: number) => void

export interface ImportDiscoveredInput {
  workspaceId: string
  missionId: string | null
  sourceName: string
  candidates: ProspectCandidate[]
  icp?: ICPConfig
  // Called after each candidate so a caller can checkpoint PARTIAL counts.
  onProgress?: ImportProgress
}

export interface ImportDiscoveredResult {
  imported: number
  skipped: number
}

export async function importDiscoveredProspects(input: ImportDiscoveredInput): Promise<ImportDiscoveredResult> {
  const { workspaceId, missionId, sourceName, candidates, icp, onProgress } = input

  // Dedup against existing prospects using targeted IN queries — only the
  // domains/names present in this batch, not the whole table.
  const candidateDomains = candidates.map(c => normalizeDomain(c.domain)).filter(Boolean) as string[]
  const candidateNames = candidates.map(c => c.companyName?.toLowerCase()).filter(Boolean) as string[]

  const [existingDomainRows, existingNameRows] = await Promise.all([
    candidateDomains.length > 0
      ? prisma.prospect.findMany({ where: { workspaceId, domainKey: { in: candidateDomains } }, select: { domainKey: true } })
      : [],
    candidateNames.length > 0
      ? prisma.prospect.findMany({ where: { workspaceId, companyName: { in: candidateNames } }, select: { companyName: true } })
      : [],
  ])
  const existingDomains = new Set(
    (existingDomainRows as Array<{ domainKey: string | null }>).map(p => p.domainKey).filter(Boolean) as string[]
  )
  const existingNames = new Set(
    (existingNameRows as Array<{ companyName: string }>).map(p => p.companyName.toLowerCase())
  )

  let imported = 0
  let skipped = 0

  for (const c of candidates) {
    if (!c.companyName) { skipped++; onProgress?.(imported, skipped); continue }
    const dk = normalizeDomain(c.domain)
    const nk = c.companyName.toLowerCase()
    if ((dk && existingDomains.has(dk)) || existingNames.has(nk)) { skipped++; onProgress?.(imported, skipped); continue }

    const meta = {
      industry: c.industry ?? null,
      employeeCount: c.employeeCount ?? null,
      contactEmail: c.contactEmail ?? null,
      contactName: c.contactName ?? null,
      domain: c.domain ?? null,
      location: c.location ?? null,
    }
    const scores = calculateOpportunityScores([], meta, icp)
    const buyingStage = detectBuyingStage([], scores.opportunityScore)
    const winProbability = calcWinProbability(buyingStage, scores.opportunityScore)

    let created: { id: string }
    try {
      created = await prisma.prospect.create({
        data: {
          workspaceId,
          companyName: c.companyName,
          domain: meta.domain,
          domainKey: dk,
          companyNameKey: normalizeCompanyNameKey(c.companyName),
          emailKey: normalizeEmailKey(meta.contactEmail),
          industry: meta.industry,
          employeeCount: meta.employeeCount,
          location: meta.location,
          description: c.description ?? null,
          contactName: meta.contactName,
          contactEmail: meta.contactEmail,
          contactTitle: c.contactTitle ?? null,
          sourceTag: sourceName,
          missionId,
          ...scores,
          buyingStage,
          winProbability,
        },
        select: { id: true },
      })
    } catch (err) {
      // P2002 = the (workspaceId, domainKey) partial unique index fired: a
      // concurrent run already created this prospect between our check and insert.
      // That's a successful dedup, not a failure — count it skipped and move on so
      // a race never escalates to a PARTIAL run. Any other error propagates.
      if ((err as { code?: string }).code === 'P2002') {
        if (dk) existingDomains.add(dk)
        existingNames.add(nk)
        skipped++
        onProgress?.(imported, skipped)
        continue
      }
      throw err
    }

    // Seed HIRING/FUNDING signals from the candidate payload — no extra API call.
    const now = new Date()
    if (c.hiringCount && c.hiringCount > 0) {
      const title = `${c.hiringCount} open position${c.hiringCount !== 1 ? 's' : ''} detected`
      await ingestSignal({
        workspaceId, prospectId: created.id, type: 'HIRING',
        strength: Math.min(95, 50 + c.hiringCount * 4),
        sourceReliability: 80, industryRelevance: 75,
        title, source: sourceName, detectedAt: now,
        evidence: { provider: sourceName, sourceType: 'discovery', confidence: 0.8, observedAt: now },
      }).catch((err: unknown) => console.warn(`[discover] HIRING signal upsert failed: ${(err as Error).message}`))
    }
    if (c.fundingStage && c.totalFunding && c.totalFunding > 0) {
      const amt = `$${(c.totalFunding / 1_000_000).toFixed(1)}M`
      const title = `${c.fundingStage} · ${amt} total funding`
      await ingestSignal({
        workspaceId, prospectId: created.id, type: 'FUNDING',
        strength: 85, sourceReliability: 90, industryRelevance: 80,
        title, source: sourceName, detectedAt: now,
        evidence: { provider: sourceName, sourceType: 'discovery', confidence: 0.9, observedAt: now },
      }).catch((err: unknown) => console.warn(`[discover] FUNDING signal upsert failed: ${(err as Error).message}`))
    }

    if (dk) existingDomains.add(dk)
    existingNames.add(nk)
    imported++
    onProgress?.(imported, skipped)
  }

  return { imported, skipped }
}
