import type { Router } from 'express'
import { requireVerifiedEmail } from '../../middleware/auth.js'
import { asyncHandler, ApiError } from '../../lib/http.js'
import { recordAudit } from '../../lib/audit.js'
import { checkAndIncrementDiscoveryUsage } from '../../lib/limits.js'
import { prisma } from '../../lib/prisma.js'
import {
  calculateOpportunityScores,
  detectBuyingStage,
  calcWinProbability,
  type ICPConfig,
  type SignalType,
} from '../../lib/signalEngine.js'
import { assertMinimumWorkspaceRole } from '../../lib/workspaces.js'
import { enqueueScoreProspects } from '../../lib/queues.js'
import { ingestSignal } from '../../lib/signalIngest.js'
import { listSources, getSource, type ProspectCandidate } from '../../lib/prospectSources.js'
import { getPack } from '../../lib/packs/index.js'
import { dollarsToCents } from '../../lib/money.js'
import { validate } from '../../lib/validate.js'
import { z } from 'zod'
import { discoverSchema, nonEmpty, normalizeDomain, getICP, IMPORT_SIGNAL_TYPES } from './helpers.js'
import { workspaceIdField } from '../../lib/validate.js'

// POST /import body. Mirrors the prior checks: workspaceId required (400), rows a
// non-empty array (400), at most 1000 rows (400). Row objects stay free-form —
// the handler reads fields defensively per row, so they're passed through as-is.
const importProspectsSchema = z.object({
  workspaceId: workspaceIdField,
  rows: z.array(z.record(z.string(), z.unknown()))
    .min(1, 'rows array required')
    .max(1000, 'Maximum 1000 rows per import'),
})

export function registerDiscoveryRoutes(prospectsRouter: Router) {
  // POST /api/prospects/discover — pull companies from a source using the workspace
  // ICP, falling back to the mission's playbook preset when scoped to a mission.
  prospectsRouter.post('/discover', requireVerifiedEmail, validate(discoverSchema), asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof discoverSchema>
    const workspaceId = body.workspaceId

    const userId = req.user!.id
    await assertMinimumWorkspaceRole(userId, workspaceId, 'admin')

    // Optionally scope the run to a mission so the mission control plane owns its
    // discovered prospects + activity. The mission must belong to the same workspace.
    const missionId = typeof body.missionId === 'string' && body.missionId.trim() ? body.missionId.trim() : null
    let missionPlaybookId: string | null = null
    if (missionId) {
      const mission = await prisma.mission.findUnique({ where: { id: missionId }, select: { workspaceId: true, playbookId: true } })
      if (!mission || mission.workspaceId !== workspaceId) throw new ApiError(404, 'Mission not found')
      missionPlaybookId = mission.playbookId
    }

    const sourceName = String(body.source ?? 'apollo')
    const source = getSource(sourceName)
    if (!source) throw new ApiError(400, `Unknown source: ${sourceName}`)
    if (!source.isConfigured) {
      const available = listSources().filter(s => s.name !== 'csv' && s.isConfigured).map(s => s.label)
      const hint = available.length > 0
        ? `Available: ${available.join(', ')}`
        : 'No discovery sources configured. Set APOLLO_API_KEY or GOOGLE_PLACES_API_KEY.'
      throw new ApiError(503, `${source.label} is not configured. ${hint}`)
    }

    // Enforce the per-workspace monthly discovery quota (cost/abuse control on
    // platform-level provider keys). Throws 429 when the plan cap is reached.
    await checkAndIncrementDiscoveryUsage(workspaceId)

    const icp = await prisma.workspaceICP.findUnique({ where: { workspaceId } })
    const limit = body.limit ?? 25 // bounded to 1..50 by discoverSchema

    // Layered targeting: explicit request → workspace ICP → mission playbook preset.
    const pack = missionPlaybookId ? getPack(missionPlaybookId) : undefined
    const query = {
      industries: body.industries ?? nonEmpty(icp?.targetIndustries) ?? pack?.icp.targetIndustries ?? [],
      locations:  body.locations  ?? nonEmpty(icp?.targetGeos)       ?? pack?.icp.targetGeos       ?? [],
      keywords:   body.keywords   ?? [],
      minEmployees: icp?.minEmployees ?? body.minEmployees ?? pack?.icp.minEmployees,
      maxEmployees: icp?.maxEmployees ?? body.maxEmployees ?? pack?.icp.maxEmployees,
      limit,
    }

    // Audit the run so users can distinguish "no prospects" from a provider
    // failure / quota / misconfiguration.
    const run = await prisma.discoveryRun.create({
      data: { workspaceId, missionId, source: sourceName, status: 'RUNNING', query },
      select: { id: true },
    })

    let candidates: ProspectCandidate[]
    try {
      candidates = await source.search(query)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Discovery provider error'
      const code = (err as { code?: string }).code ?? 'PROVIDER_ERROR'
      await prisma.discoveryRun.update({
        where: { id: run.id },
        data: { status: 'FAILED', errorCode: code, errorMessage: message.slice(0, 500), finishedAt: new Date() },
      })
      void recordAudit({
        workspaceId, actorUserId: userId, type: 'discovery.failed',
        entityType: 'discoveryRun', entityId: run.id, metadata: { source: sourceName, errorCode: code },
      })
      throw new ApiError(502, `Discovery via ${source.label} failed: ${message}`)
    }

    if (candidates.length === 0) {
      await prisma.discoveryRun.update({
        where: { id: run.id },
        data: { status: 'SUCCEEDED', resultCount: 0, finishedAt: new Date() },
      })
      return res.json({ discovered: 0, skipped: 0, total: 0, runId: run.id })
    }

    // Deduplicate against existing prospects using targeted IN queries — only
    // check domains/names that appear in this candidate batch, not the full table.
    const candidateDomains = candidates.map(c => c.domain?.toLowerCase()).filter(Boolean) as string[]
    const candidateNames   = candidates.map(c => c.companyName.toLowerCase()).filter(Boolean)

    const [existingDomainRows, existingNameRows] = await Promise.all([
      candidateDomains.length > 0
        ? prisma.prospect.findMany({ where: { workspaceId, domain: { in: candidateDomains } }, select: { domain: true } })
        : [],
      prisma.prospect.findMany({ where: { workspaceId, companyName: { in: candidateNames } }, select: { companyName: true } }),
    ])
    const existingDomains = new Set((existingDomainRows as Array<{ domain: string | null }>).map((p: { domain: string | null }) => p.domain!.toLowerCase()))
    const existingNames   = new Set((existingNameRows as Array<{ companyName: string }>).map((p: { companyName: string }) => p.companyName.toLowerCase()))

    const icpCfg: ICPConfig | undefined = icp ? {
      targetIndustries: icp.targetIndustries,
      minEmployees: icp.minEmployees ?? undefined,
      maxEmployees: icp.maxEmployees ?? undefined,
      targetGeos:   icp.targetGeos,
      mustHaveEmail: icp.mustHaveEmail,
    } : undefined

    let discovered = 0
    let skipped    = 0

    for (const c of candidates) {
      if (!c.companyName) { skipped++; continue }
      const dk = c.domain?.toLowerCase()
      const nk = c.companyName.toLowerCase()
      if ((dk && existingDomains.has(dk)) || existingNames.has(nk)) { skipped++; continue }

      const meta = {
        industry:      c.industry      ?? null,
        employeeCount: c.employeeCount ?? null,
        contactEmail:  c.contactEmail  ?? null,
        contactName:   c.contactName   ?? null,
        domain:        c.domain        ?? null,
        location:      c.location      ?? null,
      }
      const scores         = calculateOpportunityScores([], meta, icpCfg)
      const buyingStage    = detectBuyingStage([], scores.opportunityScore)
      const winProbability = calcWinProbability(buyingStage, scores.opportunityScore)

      const created = await prisma.prospect.create({
        data: {
          workspaceId,
          companyName:  c.companyName,
          domain:       meta.domain,
          domainKey:    normalizeDomain(meta.domain),
          industry:     meta.industry,
          employeeCount: meta.employeeCount,
          location:     meta.location,
          description:  c.description  ?? null,
          contactName:  meta.contactName,
          contactEmail: meta.contactEmail,
          contactTitle: c.contactTitle  ?? null,
          sourceTag:    sourceName,
          missionId,
          ...scores,
          buyingStage,
          winProbability,
        }
      })

      // Seed HIRING/FUNDING signals from source data — no extra API call needed.
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
      discovered++
    }

    if (discovered > 0) {
      enqueueScoreProspects(workspaceId).catch(() => {})
    }

    await prisma.discoveryRun.update({
      where: { id: run.id },
      data: {
        status: 'SUCCEEDED',
        resultCount: candidates.length,
        importedCount: discovered,
        skippedCount: skipped,
        finishedAt: new Date(),
      },
    })

    res.json({ discovered, skipped, total: candidates.length, runId: run.id })
  }))

  // POST /api/prospects/import — bulk import from CSV rows (parsed on the client)
  prospectsRouter.post('/import', requireVerifiedEmail, validate(importProspectsSchema), asyncHandler(async (req, res) => {
    const { workspaceId, rows } = req.body as z.infer<typeof importProspectsSchema>

    const userId = req.user!.id
    await assertMinimumWorkspaceRole(userId, workspaceId, 'admin')

    const icp = await getICP(workspaceId)

    let imported = 0
    let skipped = 0
    const errors: string[] = []

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const companyName = String(row.companyName ?? row.company ?? row.name ?? '').trim()
      if (!companyName) { skipped++; continue }
      try {
        const meta = {
          industry:      row.industry      ? String(row.industry)      : null,
          employeeCount: row.employeeCount ? Number(row.employeeCount) : null,
          contactEmail:  row.contactEmail  ? String(row.contactEmail)  : null,
          contactName:   row.contactName   ? String(row.contactName)   : null,
          domain:        row.domain        ? String(row.domain)        : null,
          location:      row.location      ? String(row.location)      : null,
        }
        const scores        = calculateOpportunityScores([], meta, icp)
        const buyingStage   = detectBuyingStage([], scores.opportunityScore)
        const winProbability = calcWinProbability(buyingStage, scores.opportunityScore)

        await prisma.prospect.create({
          data: {
            workspaceId,
            companyName,
            domain:        meta.domain,
            domainKey:     normalizeDomain(meta.domain),
            industry:      meta.industry,
            employeeCount: meta.employeeCount,
            location:      meta.location,
            contactName:   meta.contactName,
            contactEmail:  meta.contactEmail,
            contactPhone:  row.contactPhone  ? String(row.contactPhone)  : null,
            contactTitle:  row.contactTitle  ? String(row.contactTitle)  : null,
            linkedinUrl:   row.linkedinUrl   ? String(row.linkedinUrl)   : null,
            description:   row.description   ? String(row.description)   : null,
            notes:         row.notes         ? String(row.notes)         : null,
            sourceTag:     row.sourceTag     ? String(row.sourceTag)     : 'csv_import',
            estimatedRevenue: row.estimatedRevenue ? dollarsToCents(Number(row.estimatedRevenue)) : null,
            expectedDealValue: row.expectedDealValue ? dollarsToCents(Number(row.expectedDealValue)) : null,
            ...scores,
            buyingStage,
            winProbability,
          }
        })
        imported++
      } catch (err) {
        errors.push(`Row ${i + 1} (${companyName}): ${(err as Error).message}`)
      }
    }

    res.status(201).json({ imported, skipped, failed: errors.length, errors: errors.slice(0, 20) })
  }))

  // POST /api/prospects/import-signals — bulk feed signal-backed prospects (the
  // pilot enabler): each row becomes a prospect + an evidence-backed Signal via the
  // unified ingest spine, then scoring runs (which auto-generates recommendations
  // and intents). Evidence is mandatory — this is the evidence-first front door.
  prospectsRouter.post('/import-signals', requireVerifiedEmail, asyncHandler(async (req, res) => {
    const workspaceId = String(req.body?.workspaceId || '').trim()
    if (!workspaceId) throw new ApiError(400, 'workspaceId required')
    const rows: Record<string, unknown>[] = req.body?.rows
    if (!Array.isArray(rows) || rows.length === 0) throw new ApiError(400, 'rows array required')
    if (rows.length > 500) throw new ApiError(400, 'Maximum 500 rows per import')

    const userId = req.user!.id
    await assertMinimumWorkspaceRole(userId, workspaceId, 'admin')

    let prospectsCreated = 0
    let prospectsReused = 0
    let signalsIngested = 0
    const errors: string[] = []

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const companyName = String(row.companyName ?? row.company ?? row.name ?? '').trim()
      const signalType = String(row.signalType ?? row.type ?? '').trim().toUpperCase()
      try {
        if (!companyName) throw new Error('companyName required')
        if (!IMPORT_SIGNAL_TYPES.has(signalType as SignalType)) throw new Error(`invalid signalType "${signalType}"`)
        const provider = String(row.provider ?? row.evidenceProvider ?? '').trim()
        const sourceType = String(row.sourceType ?? row.evidenceType ?? '').trim()
        if (!provider || !sourceType) throw new Error('evidence requires provider and sourceType')

        const domain = row.domain ? String(row.domain) : null
        const domainKey = normalizeDomain(domain)
        const sourceUrl = row.sourceUrl ? String(row.sourceUrl) : null
        const observedAt = row.observedAt ? new Date(String(row.observedAt)) : undefined

        let prospect = domainKey
          ? await prisma.prospect.findFirst({ where: { workspaceId, domainKey }, select: { id: true } })
          : await prisma.prospect.findFirst({ where: { workspaceId, companyName }, select: { id: true } })
        if (prospect) {
          prospectsReused++
        } else {
          prospect = await prisma.prospect.create({
            data: {
              workspaceId, companyName, domain, domainKey,
              industry: row.industry ? String(row.industry) : null,
              location: row.location ? String(row.location) : null,
              contactEmail: row.contactEmail ? String(row.contactEmail) : null,
              contactName: row.contactName ? String(row.contactName) : null,
              sourceTag: 'signal_import',
            },
            select: { id: true },
          })
          prospectsCreated++
        }

        await ingestSignal({
          workspaceId, prospectId: prospect.id,
          type: signalType as SignalType,
          strength: row.strength !== undefined ? Number(row.strength) : 70,
          source: row.signalSource ? String(row.signalSource) : provider,
          title: row.signalTitle ? String(row.signalTitle) : null,
          sourceUrl,
          detectedAt: observedAt,
          evidence: {
            provider, sourceType, sourceUrl,
            confidence: row.confidence !== undefined ? Number(row.confidence) : 0.7,
            observedAt,
            rawText: row.rawText ? String(row.rawText) : null,
          },
        })
        signalsIngested++
      } catch (err) {
        errors.push(`Row ${i + 1} (${companyName || '?'}): ${(err as Error).message}`)
      }
    }

    // Score the workspace once — this cascades into auto-recommendations + intents.
    if (signalsIngested > 0) enqueueScoreProspects(workspaceId).catch(() => {})

    res.status(201).json({ prospectsCreated, prospectsReused, signalsIngested, failed: errors.length, errors: errors.slice(0, 20) })
  }))
}
