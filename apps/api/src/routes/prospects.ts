import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import {
  calculateOpportunityScores,
  detectBuyingStage,
  calcWinProbability,
  generateRuleBasedRecommendation,
  getOpportunityTier,
  predictBuyingIntent,
  toRawSignal,
  type ICPConfig,
} from '../lib/signalEngine.js'
import { userHasWorkspaceAccess } from '../lib/workspaces.js'
import { enqueueScoreProspects, enqueueCalibrate } from '../lib/queues.js'
import { enrichProspect } from '../services/apollo.js'
import { listSources, getSource } from '../lib/prospectSources.js'
import { findContactEmail, isHunterConfigured } from '../services/hunter.js'
import { dollarsToCents, centsToDollars } from '../lib/money.js'
import { escCsv } from '../lib/csv.js'
import type { AuthedRequest } from '../types/auth.js'

export const prospectsRouter = Router()
prospectsRouter.use(requireAuth)

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
        sourceTag: true, createdAt: true, updatedAt: true,
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
  })
}))

// GET /api/prospects/sources — which discovery integrations are wired up
prospectsRouter.get('/sources', asyncHandler(async (_req, res) => {
  res.json({ sources: listSources() })
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
      signals:         { orderBy: { detectedAt: 'desc' } },
      recommendations: { orderBy: { priority: 'desc' } },
      outcomes:        { orderBy: { recordedAt: 'desc' } },
    },
  })
  if (!prospect) throw new ApiError(404, 'Prospect not found')

  const userId = (req as AuthedRequest).user.id
  if (!await userHasWorkspaceAccess(userId, prospect.workspaceId)) throw new ApiError(403, 'Access denied')

  const rawSignals = prospect.signals.map(toRawSignal)
  const prediction = predictBuyingIntent(rawSignals, prospect.buyingStage, prospect.opportunityScore)

  res.json(withDollars({ ...prospect, tier: getOpportunityTier(prospect.opportunityScore), prediction }))
}))

// POST /api/prospects/discover — pull companies from Apollo using workspace ICP
prospectsRouter.post('/discover', asyncHandler(async (req, res) => {
  const workspaceId = req.body.workspaceId as string
  if (!workspaceId) throw new ApiError(400, 'workspaceId required')

  const userId = (req as AuthedRequest).user.id
  if (!await userHasWorkspaceAccess(userId, workspaceId)) throw new ApiError(403, 'Access denied')

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

  const icp = await prisma.workspaceICP.findUnique({ where: { workspaceId } })
  const limit = Math.min(Number(req.body.limit ?? 25), 50)

  const candidates = await source.search({
    industries: req.body.industries ?? icp?.targetIndustries ?? [],
    locations:  req.body.locations  ?? icp?.targetGeos       ?? [],
    keywords:   req.body.keywords   ?? [],
    minEmployees: icp?.minEmployees  ?? req.body.minEmployees,
    maxEmployees: icp?.maxEmployees  ?? req.body.maxEmployees,
    limit,
  })

  if (candidates.length === 0) {
    return res.json({ discovered: 0, skipped: 0, total: 0 })
  }

  // Deduplicate against existing prospects (domain preferred, name fallback)
  const [existingDomainRows, existingNameRows] = await Promise.all([
    prisma.prospect.findMany({ where: { workspaceId, domain: { not: null } }, select: { domain: true } }),
    prisma.prospect.findMany({ where: { workspaceId }, select: { companyName: true } }),
  ])
  const existingDomains = new Set(existingDomainRows.map(p => p.domain!.toLowerCase()))
  const existingNames   = new Set(existingNameRows.map(p => p.companyName.toLowerCase()))

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

    // Seed HIRING/FUNDING signals directly from Apollo's company search data —
    // no extra API call needed, Apollo includes these in the company response.
    if (c.hiringCount && c.hiringCount > 0) {
      await prisma.signal.create({
        data: {
          workspaceId,
          prospectId: created.id,
          type: 'HIRING',
          strength: Math.min(95, 50 + c.hiringCount * 4),
          sourceReliability: 80,
          industryRelevance: 75,
          title: `${c.hiringCount} open position${c.hiringCount !== 1 ? 's' : ''} on Apollo`,
          source: 'apollo',
          detectedAt: new Date(),
        }
      }).catch(() => {})
    }
    if (c.fundingStage && c.totalFunding && c.totalFunding > 0) {
      const amt = `$${(c.totalFunding / 1_000_000).toFixed(1)}M`
      await prisma.signal.create({
        data: {
          workspaceId,
          prospectId: created.id,
          type: 'FUNDING',
          strength: 85,
          sourceReliability: 90,
          industryRelevance: 80,
          title: `${c.fundingStage} · ${amt} total funding`,
          source: 'apollo',
          detectedAt: new Date(),
        }
      }).catch(() => {})
    }

    if (dk) existingDomains.add(dk)
    existingNames.add(nk)
    discovered++
  }

  if (discovered > 0) {
    enqueueScoreProspects(workspaceId).catch(() => {})
  }

  res.json({ discovered, skipped, total: candidates.length })
}))

// POST /api/prospects/import — bulk import from CSV rows (parsed on the client)
prospectsRouter.post('/import', asyncHandler(async (req, res) => {
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

  const result = await enrichProspect(prospect)

  const created: string[] = []
  for (const sig of result.signals) {
    const s = await prisma.signal.create({
      data: {
        workspaceId:       prospect.workspaceId,
        prospectId:        prospect.id,
        type:              sig.type as import('@prisma/client').SignalType,
        strength:          sig.strength,
        sourceReliability: sig.sourceReliability,
        industryRelevance: sig.industryRelevance,
        title:             sig.title,
        description:       sig.description,
        source:            sig.source,
        detectedAt:        sig.detectedAt,
      }
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
  const latestSignalAt = allSignals.reduce<Date | null>((max, s) => {
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
