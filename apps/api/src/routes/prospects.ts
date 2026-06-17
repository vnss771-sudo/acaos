import { Router } from 'express'
import { requireAuth, requireVerifiedEmail } from '../middleware/auth.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { recordAudit } from '../lib/audit.js'
import { checkAndIncrementDiscoveryUsage } from '../lib/limits.js'
import { prisma } from '../lib/prisma.js'
import {
  calculateOpportunityScores,
  detectBuyingStage,
  calcWinProbability,
  generateRuleBasedRecommendation,
  getOpportunityTier,
  predictBuyingIntent,
  toRawSignal,
  freshnessState,
  type ICPConfig,
  type SignalType,
} from '../lib/signalEngine.js'
import { userHasWorkspaceAccess } from '../lib/workspaces.js'
import { enqueueScoreProspects, enqueueCalibrate } from '../lib/queues.js'
import { enrichProspect } from '../services/apollo.js'
import { ingestSignal } from '../lib/signalIngest.js'
import { listSources, getSource, type ProspectCandidate } from '../lib/prospectSources.js'
import { findContactEmail, isHunterConfigured } from '../services/hunter.js'
import { dollarsToCents, centsToDollars } from '../lib/money.js'
import { escCsv } from '../lib/csv.js'
import type { AuthedRequest } from '../types/auth.js'

export const prospectsRouter = Router()
prospectsRouter.use(requireAuth)

export function normalizeDomain(domain: string | null | undefined): string | null {
  if (!domain) return null
  return domain.toLowerCase().replace(/^www\./, '')
}


// Money is stored as integer cents; expose whole-unit amounts at the API edge.
function withDollars<T extends Record<string, unknown>>(p: T): T {
  const out: Record<string, unknown> = { ...p }
  if ('expectedDealValue' in out) out.expectedDealValue = centsToDollars(out.expectedDealValue as number | null)
  if ('estimatedRevenue' in out) out.estimatedRevenue = centsToDollars(out.estimatedRevenue as number | null)
  return out as T
}

// Single canonical ICP loader — returns shaped ICPConfig or undefined
async function getICP(workspaceId: string): Promise<ICPConfig | undefined> {
  const icp = await prisma.workspaceICP.findUnique({ where: { workspaceId } })
  if (!icp) return undefined
  return {
    targetIndustries: icp.targetIndustries,
    minEmployees:     icp.minEmployees  ?? undefined,
    maxEmployees:     icp.maxEmployees  ?? undefined,
    targetGeos:       icp.targetGeos,
    mustHaveEmail:    icp.mustHaveEmail,
  }
}

// GET /api/prospects?workspaceId=&tier=&stage=&outcome=&search=&page=&limit=
prospectsRouter.get('/', asyncHandler(async (req, res) => {
  const workspaceId = req.query.workspaceId as string
  if (!workspaceId) throw new ApiError(400, 'workspaceId required')

  const userId = (req as AuthedRequest).user.id
  if (!await userHasWorkspaceAccess(userId, workspaceId)) throw new ApiError(403, 'Access denied')

  const page  = Math.max(1, parseInt(req.query.page  as string) || 1)
  const limit = Math.min(100, parseInt(req.query.limit as string) || 25)
  const skip  = (page - 1) * limit

  const tierFilter    = req.query.tier    as string | undefined
  const stageFilter   = req.query.stage   as string | undefined
  const outcomeFilter = req.query.outcome as string | undefined
  const search        = req.query.search  as string | undefined

  const where: Record<string, unknown> = { workspaceId }
  if (stageFilter)   where.buyingStage  = stageFilter
  if (outcomeFilter) where.outcomeStage = outcomeFilter
  if (search)        where.companyName  = { contains: search, mode: 'insensitive' }

  if (tierFilter) {
    const tier = tierFilter.toUpperCase()
    if      (tier === 'HOT')  where.opportunityScore = { gte: 72 }
    else if (tier === 'WARM') where.opportunityScore = { gte: 45, lt: 72 }
    else if (tier === 'COLD') where.opportunityScore = { lt: 45 }
  }

  // Count real (non-example) prospects once: it decides whether to auto-hide the
  // example/onboarding prospects AND is reported to the client. Computed up front
  // because the hide decision feeds the findMany `where`.
  const realCount = await prisma.prospect.count({ where: { workspaceId, isExample: false } })
  const showExamples = req.query.showExamples === 'true'
  if (!showExamples && realCount > 0) where.isExample = false

  const [prospects, total] = await Promise.all([
    prisma.prospect.findMany({
      where,
      select: {
        id: true, workspaceId: true, companyName: true, domain: true,
        industry: true, employeeCount: true, location: true,
        contactName: true, contactEmail: true, contactPhone: true, contactTitle: true,
        linkedinUrl: true, opportunityScore: true, intentScore: true, fitScore: true,
        timingScore: true, confidenceScore: true,
        buyingStage: true, outcomeStage: true, expectedDealValue: true,
        winProbability: true, lastSignalAt: true, lastContactedAt: true,
        sourceTag: true, isExample: true, createdAt: true, updatedAt: true,
        _count: { select: { signals: true } },
        recommendations: { orderBy: { priority: 'desc' }, take: 1 },
      },
      orderBy: { opportunityScore: 'desc' },
      skip,
      take: limit + 1,
    }),
    prisma.prospect.count({ where }),
  ])

  const hasMore = prospects.length > limit
  if (hasMore) prospects.pop()

  res.json({
    prospects: prospects.map((p: (typeof prospects)[0]) => withDollars({
      ...p,
      signalCount:       p._count.signals,
      tier:              getOpportunityTier(p.opportunityScore),
      topRecommendation: p.recommendations[0] ?? null,
    })),
    page,
    limit,
    total,
    hasMore,
    hasRealProspects: realCount > 0,
  })
}))

// GET /api/prospects/sources — which discovery integrations are wired up
prospectsRouter.get('/sources', asyncHandler(async (_req, res) => {
  res.json({ sources: listSources() })
}))

// GET /api/prospects/discovery-runs?workspaceId= — recent discovery run history.
// Registered before GET /:id so "discovery-runs" isn't matched as a prospect id.
prospectsRouter.get('/discovery-runs', asyncHandler(async (req, res) => {
  const workspaceId = String(req.query.workspaceId || '').trim()
  if (!workspaceId) throw new ApiError(400, 'workspaceId required')
  const userId = (req as AuthedRequest).user.id
  if (!await userHasWorkspaceAccess(userId, workspaceId)) throw new ApiError(403, 'Access denied')

  const runs = await prisma.discoveryRun.findMany({
    where: { workspaceId },
    orderBy: { startedAt: 'desc' },
    take: 20,
    select: {
      id: true, source: true, status: true, resultCount: true, importedCount: true,
      skippedCount: true, errorCode: true, errorMessage: true, startedAt: true, finishedAt: true,
    },
  })
  res.json({ runs })
}))

// GET /api/prospects/export?workspaceId=&format=csv
prospectsRouter.get('/export', asyncHandler(async (req, res) => {
  const user = (req as AuthedRequest).user
  const workspaceId = String(req.query.workspaceId || '').trim()
  if (!workspaceId) throw new ApiError(400, 'workspaceId required')

  if (!await userHasWorkspaceAccess(user.id, workspaceId)) throw new ApiError(403, 'Access denied')

  const HEADERS = ['id','companyName','domain','industry','employeeCount','location','contactName','contactEmail','contactPhone','contactTitle','linkedinUrl','opportunityScore','intentScore','fitScore','buyingStage','outcomeStage','winProbability','expectedDealValue','estimatedRevenue','sourceTag','createdAt','updatedAt']

  res.setHeader('Content-Type', 'text/csv')
  res.setHeader('Content-Disposition', `attachment; filename="prospects-${workspaceId}-${new Date().toISOString().slice(0,10)}.csv"`)
  res.write(HEADERS.join(',') + '\n')

  // Cursor-based pagination prevents OOM on large workspaces.
  // Sort by id (unique, stable) to avoid skipped/duplicated rows when multiple
  // rows share the same createdAt timestamp (common in bulk imports).
  const PAGE = 500
  let cursor: string | undefined
  let totalWritten = 0
  const MAX = 50_000

  while (totalWritten < MAX) {
    const batch = await prisma.prospect.findMany({
      where: { workspaceId },
      select: {
        id: true, companyName: true, domain: true, industry: true, employeeCount: true,
        location: true, contactName: true, contactEmail: true, contactPhone: true, contactTitle: true,
        linkedinUrl: true, opportunityScore: true, intentScore: true, fitScore: true,
        buyingStage: true, outcomeStage: true, winProbability: true,
        expectedDealValue: true, estimatedRevenue: true, sourceTag: true,
        createdAt: true, updatedAt: true
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: PAGE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {})
    })

    if (batch.length === 0) break
    for (const p of batch) {
      res.write(HEADERS.map(h => escCsv((p as Record<string, unknown>)[h])).join(',') + '\n')
    }
    totalWritten += batch.length
    cursor = batch[batch.length - 1].id
    if (batch.length < PAGE) break
  }

  res.end()
}))

// GET /api/prospects/:id
prospectsRouter.get('/:id', asyncHandler(async (req, res) => {
  const prospect = await prisma.prospect.findUnique({
    where: { id: req.params.id as string },
    include: {
      signals:         { orderBy: { detectedAt: 'desc' }, include: { evidenceSource: true } },
      recommendations: { orderBy: { priority: 'desc' } },
      outcomes:        { orderBy: { recordedAt: 'desc' } },
    },
  })
  if (!prospect) throw new ApiError(404, 'Prospect not found')

  const userId = (req as AuthedRequest).user.id
  if (!await userHasWorkspaceAccess(userId, prospect.workspaceId)) throw new ApiError(403, 'Access denied')

  const rawSignals = prospect.signals.map(toRawSignal)
  const prediction = predictBuyingIntent(rawSignals, prospect.buyingStage, prospect.opportunityScore)

  const scoreBreakdown = prospect.signals?.map((s: any) => ({
    type: s.type,
    title: s.title,
    contribution: s.weight ?? null,
    detectedAt: s.detectedAt,
    freshness: freshnessState({ type: s.type, detectedAt: s.detectedAt }),
    evidence: s.evidenceSource
      ? {
          provider: s.evidenceSource.provider,
          sourceType: s.evidenceSource.sourceType,
          sourceUrl: s.evidenceSource.sourceUrl,
          confidence: s.evidenceSource.confidence,
          observedAt: s.evidenceSource.observedAt,
        }
      : null,
  })) ?? []

  res.json({ ...withDollars({ ...prospect, tier: getOpportunityTier(prospect.opportunityScore), prediction }), scoreBreakdown })
}))

// POST /api/prospects/discover — pull companies from Apollo using workspace ICP
prospectsRouter.post('/discover', requireVerifiedEmail, asyncHandler(async (req, res) => {
  const workspaceId = req.body.workspaceId as string
  if (!workspaceId) throw new ApiError(400, 'workspaceId required')

  const userId = (req as AuthedRequest).user.id
  if (!await userHasWorkspaceAccess(userId, workspaceId)) throw new ApiError(403, 'Access denied')

  // Optionally scope the run to a mission so the mission control plane can show
  // its own discovery activity. The mission must belong to the same workspace.
  const missionId = typeof req.body.missionId === 'string' && req.body.missionId.trim()
    ? req.body.missionId.trim()
    : null
  if (missionId) {
    const mission = await prisma.mission.findUnique({ where: { id: missionId }, select: { workspaceId: true } })
    if (!mission || mission.workspaceId !== workspaceId) throw new ApiError(404, 'Mission not found')
  }

  const sourceName = String(req.body.source ?? 'apollo')
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
  const limit = Math.min(Number(req.body.limit ?? 25), 50)

  const query = {
    industries: req.body.industries ?? icp?.targetIndustries ?? [],
    locations:  req.body.locations  ?? icp?.targetGeos       ?? [],
    keywords:   req.body.keywords   ?? [],
    minEmployees: icp?.minEmployees  ?? req.body.minEmployees,
    maxEmployees: icp?.maxEmployees  ?? req.body.maxEmployees,
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
prospectsRouter.post('/import', requireVerifiedEmail, asyncHandler(async (req, res) => {
  const workspaceId = req.body.workspaceId as string
  if (!workspaceId) throw new ApiError(400, 'workspaceId required')
  const rows: Record<string, unknown>[] = req.body.rows
  if (!Array.isArray(rows) || rows.length === 0) throw new ApiError(400, 'rows array required')
  if (rows.length > 1000) throw new ApiError(400, 'Maximum 1000 rows per import')

  const userId = (req as AuthedRequest).user.id
  if (!await userHasWorkspaceAccess(userId, workspaceId)) throw new ApiError(403, 'Access denied')

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

// POST /api/prospects
prospectsRouter.post('/', asyncHandler(async (req, res) => {
  const workspaceId = req.body.workspaceId as string
  if (!workspaceId)          throw new ApiError(400, 'workspaceId required')
  if (!req.body.companyName) throw new ApiError(400, 'companyName required')

  const userId = (req as AuthedRequest).user.id
  if (!await userHasWorkspaceAccess(userId, workspaceId)) throw new ApiError(403, 'Access denied')

  const meta = {
    industry:      req.body.industry      ?? null,
    employeeCount: req.body.employeeCount ? Number(req.body.employeeCount) : null,
    contactEmail:  req.body.contactEmail  ?? null,
    contactName:   req.body.contactName   ?? null,
    domain:        req.body.domain        ?? null,
    location:      req.body.location      ?? null,
  }

  const icp    = await getICP(workspaceId)
  const scores = calculateOpportunityScores([], meta, icp)
  const buyingStage    = detectBuyingStage([], scores.opportunityScore)
  const winProbability = calcWinProbability(buyingStage, scores.opportunityScore)

  const created = await prisma.prospect.create({
    data: {
      workspaceId,
      companyName:       req.body.companyName,
      domain:            meta.domain,
      domainKey:         normalizeDomain(meta.domain),
      industry:          meta.industry,
      employeeCount:     meta.employeeCount,
      estimatedRevenue:  req.body.estimatedRevenue  ? dollarsToCents(Number(req.body.estimatedRevenue))  : null,
      location:          meta.location,
      description:       req.body.description   ?? null,
      notes:             req.body.notes          ?? null,
      aiSummary:         req.body.aiSummary      ?? null,
      contactName:       meta.contactName,
      contactEmail:      meta.contactEmail,
      contactPhone:      req.body.contactPhone   ?? null,
      contactTitle:      req.body.contactTitle   ?? null,
      linkedinUrl:       req.body.linkedinUrl    ?? null,
      expectedDealValue: req.body.expectedDealValue ? dollarsToCents(Number(req.body.expectedDealValue)) : null,
      sourceTag:         req.body.sourceTag      ?? null,
      ...scores,
      buyingStage,
      winProbability,
    },
  })

  res.status(201).json(withDollars({ ...created, tier: getOpportunityTier(created.opportunityScore) }))
}))

// PATCH /api/prospects/:id
prospectsRouter.patch('/:id', asyncHandler(async (req, res) => {
  const existing = await prisma.prospect.findUnique({ where: { id: req.params.id as string } })
  if (!existing) throw new ApiError(404, 'Prospect not found')

  const userId = (req as AuthedRequest).user.id
  if (!await userHasWorkspaceAccess(userId, existing.workspaceId)) throw new ApiError(403, 'Access denied')

  const allowed = [
    'companyName', 'domain', 'industry', 'employeeCount', 'estimatedRevenue',
    'location', 'description', 'notes', 'aiSummary',
    'contactName', 'contactEmail', 'contactPhone', 'contactTitle',
    'linkedinUrl', 'outcomeStage', 'buyingStage', 'expectedDealValue', 'sourceTag',
  ]

  const moneyFields = new Set(['expectedDealValue', 'estimatedRevenue'])
  const data: Record<string, unknown> = {}
  for (const key of allowed) {
    if (req.body[key] === undefined) continue
    // Money arrives as whole units and is stored as integer cents.
    data[key] = moneyFields.has(key) && req.body[key] != null
      ? dollarsToCents(Number(req.body[key]))
      : req.body[key]
  }
  if (req.body.lastContactedAt) data.lastContactedAt = new Date(req.body.lastContactedAt)
  // Keep domainKey in sync whenever domain is patched
  if ('domain' in data) data.domainKey = normalizeDomain(data.domain as string | null)

  const updated = await prisma.prospect.update({ where: { id: req.params.id as string }, data })
  res.json(withDollars({ ...updated, tier: getOpportunityTier(updated.opportunityScore) }))
}))

// DELETE /api/prospects/:id
prospectsRouter.delete('/:id', asyncHandler(async (req, res) => {
  const existing = await prisma.prospect.findUnique({ where: { id: req.params.id as string } })
  if (!existing) throw new ApiError(404, 'Prospect not found')

  const userId = (req as AuthedRequest).user.id
  if (!await userHasWorkspaceAccess(userId, existing.workspaceId)) throw new ApiError(403, 'Access denied')

  await prisma.prospect.delete({ where: { id: req.params.id as string } })
  res.json({ ok: true })
}))

// POST /api/prospects/:id/rescore
prospectsRouter.post('/:id/rescore', asyncHandler(async (req, res) => {
  const prospect = await prisma.prospect.findUnique({
    where: { id: req.params.id as string },
    include: { signals: true },
  })
  if (!prospect) throw new ApiError(404, 'Prospect not found')

  const userId = (req as AuthedRequest).user.id
  if (!await userHasWorkspaceAccess(userId, prospect.workspaceId)) throw new ApiError(403, 'Access denied')

  const rawSignals     = prospect.signals.map(toRawSignal)
  const icp            = await getICP(prospect.workspaceId)
  const scores         = calculateOpportunityScores(rawSignals, {
    industry:      prospect.industry,
    employeeCount: prospect.employeeCount,
    contactEmail:  prospect.contactEmail,
    contactName:   prospect.contactName,
    domain:        prospect.domain,
    location:      prospect.location,
  }, icp)
  const buyingStage    = detectBuyingStage(rawSignals, scores.opportunityScore)
  const winProbability = calcWinProbability(buyingStage, scores.opportunityScore)

  const updated = await prisma.prospect.update({
    where: { id: req.params.id as string },
    data: { ...scores, buyingStage, winProbability },
  })
  res.json(withDollars({ ...updated, tier: getOpportunityTier(updated.opportunityScore) }))
}))

// POST /api/prospects/:id/outcome
prospectsRouter.post('/:id/outcome', asyncHandler(async (req, res) => {
  const prospect = await prisma.prospect.findUnique({ where: { id: req.params.id as string } })
  if (!prospect) throw new ApiError(404, 'Prospect not found')

  const userId = (req as AuthedRequest).user.id
  if (!await userHasWorkspaceAccess(userId, prospect.workspaceId)) throw new ApiError(403, 'Access denied')

  // Example prospects are fictional — recording outcomes against them would feed
  // demo data into the forecast and the scoring calibration loop.
  if (prospect.isExample) throw new ApiError(400, 'Example prospects cannot have outcomes — add real prospects first')

  if (!req.body.stage) throw new ApiError(400, 'stage required')

  const [outcome, updated] = await prisma.$transaction([
    prisma.prospectOutcome.create({
      data: {
        workspaceId: prospect.workspaceId,
        prospectId:  prospect.id,
        stage:       req.body.stage,
        notes:       req.body.notes     ?? null,
        dealValue:   req.body.dealValue ? dollarsToCents(Number(req.body.dealValue)) : null,
      },
    }),
    prisma.prospect.update({
      where: { id: prospect.id },
      data: {
        outcomeStage: req.body.stage,
        lastContactedAt: ['CONTACTED', 'MEETING', 'PROPOSAL', 'WON', 'LOST'].includes(req.body.stage)
          ? new Date() : undefined,
      },
    }),
  ])

  // Trigger background jobs on definitive outcomes
  if (['WON', 'LOST'].includes(req.body.stage)) {
    enqueueScoreProspects(prospect.workspaceId).catch(() => {})
    enqueueCalibrate(prospect.workspaceId).catch(() => {})
  }

  res.json({
    outcome: { ...outcome, dealValue: centsToDollars(outcome.dealValue) },
    prospect: withDollars({ ...updated, tier: getOpportunityTier(updated.opportunityScore) }),
  })
}))

// POST /api/prospects/:id/recommend
prospectsRouter.post('/:id/recommend', asyncHandler(async (req, res) => {
  const prospect = await prisma.prospect.findUnique({
    where: { id: req.params.id as string },
    include: { signals: true },
  })
  if (!prospect) throw new ApiError(404, 'Prospect not found')

  const userId = (req as AuthedRequest).user.id
  if (!await userHasWorkspaceAccess(userId, prospect.workspaceId)) throw new ApiError(403, 'Access denied')

  const rawSignals = prospect.signals.map(toRawSignal)
  const rec = generateRuleBasedRecommendation(
    {
      industry:      prospect.industry,
      employeeCount: prospect.employeeCount,
      contactEmail:  prospect.contactEmail,
      contactName:   prospect.contactName,
      contactPhone:  prospect.contactPhone,
      linkedinUrl:   prospect.linkedinUrl,
      domain:        prospect.domain,
      location:      prospect.location,
    },
    rawSignals
  )

  const recommendation = await prisma.recommendation.create({
    data: {
      workspaceId: prospect.workspaceId,
      prospectId:  prospect.id,
      ...rec,
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
    },
  })

  res.status(201).json(recommendation)
}))

// POST /api/prospects/:id/enrich — Apollo.io enrichment → auto signals → rescore
prospectsRouter.post('/:id/enrich', asyncHandler(async (req, res) => {
  const prospect = await prisma.prospect.findUnique({ where: { id: req.params.id as string } })
  if (!prospect) throw new ApiError(404, 'Prospect not found')

  const userId = (req as AuthedRequest).user.id
  if (!await userHasWorkspaceAccess(userId, prospect.workspaceId)) throw new ApiError(403, 'Access denied')

  if (prospect.isExample) throw new ApiError(400, 'Example prospects cannot be enriched — add real prospects first')

  const result = await enrichProspect(prospect)

  const created: string[] = []
  for (const sig of result.signals) {
    // Apollo-detected signals now carry provenance (EvidenceSource) so they get
    // the same "where from / how fresh" treatment as manually-added ones.
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
        provider: sig.source,
        sourceType: 'enrichment',
        confidence: Math.max(0, Math.min(1, sig.sourceReliability / 100)),
        observedAt: sig.detectedAt,
      },
    })
    created.push(s.id)
  }

  const [allSignals, icp] = await Promise.all([
    prisma.signal.findMany({ where: { prospectId: prospect.id } }),
    getICP(prospect.workspaceId)
  ])
  const rawSignals = allSignals.map(toRawSignal)
  const u          = result.updates
  const scores     = calculateOpportunityScores(rawSignals, {
    industry:      (u.industry      as string | null | undefined) ?? prospect.industry,
    employeeCount: (u.employeeCount as number | null | undefined) ?? prospect.employeeCount,
    contactEmail:  (u.contactEmail  as string | null | undefined) ?? prospect.contactEmail,
    contactName:   (u.contactName   as string | null | undefined) ?? prospect.contactName,
    domain:        (u.domain        as string | null | undefined) ?? prospect.domain,
    location:      prospect.location,
  }, icp)
  const buyingStage    = detectBuyingStage(rawSignals, scores.opportunityScore)
  const winProbability = calcWinProbability(buyingStage, scores.opportunityScore)

  // Most recent signal detectedAt — use as lastSignalAt
  const latestSignalAt = (allSignals as Array<{ detectedAt: Date }>).reduce((max: Date | null, s: { detectedAt: Date }) => {
    return !max || s.detectedAt > max ? s.detectedAt : max
  }, null)

  // Hunter email finder — if prospect has domain but no contact email, try Hunter
  if (prospect.domain && !prospect.contactEmail && !result.updates.contactEmail && isHunterConfigured()) {
    try {
      const contact = await findContactEmail(prospect.domain)
      if (contact) {
        result.updates.contactEmail = contact.email
        if (contact.firstName && !prospect.contactName) {
          result.updates.contactName = [contact.firstName, contact.lastName].filter(Boolean).join(' ')
        }
        if (contact.position && !prospect.contactTitle) {
          result.updates.contactTitle = contact.position
        }
      }
    } catch { /* non-fatal */ }
  }

  const updated = await prisma.prospect.update({
    where: { id: prospect.id },
    data: {
      ...scores,
      buyingStage,
      winProbability,
      ...(latestSignalAt && { lastSignalAt: latestSignalAt }),
      ...(Object.keys(u).length > 0 && u),
    }
  })

  res.json({
    prospect:       withDollars({ ...updated, tier: getOpportunityTier(updated.opportunityScore) }),
    signalsCreated: created.length,
    signalIds:      created
  })
}))
