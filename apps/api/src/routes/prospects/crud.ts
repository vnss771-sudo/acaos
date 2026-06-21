import type { Router } from 'express'
import { asyncHandler, ApiError } from '../../lib/http.js'
import { prisma } from '../../lib/prisma.js'
import {
  calculateOpportunityScores,
  detectBuyingStage,
  calcWinProbability,
  getOpportunityTier,
  predictBuyingIntent,
  toRawSignal,
  freshnessState,
} from '../../lib/signalEngine.js'
import { userHasWorkspaceAccess, assertMinimumWorkspaceRole } from '../../lib/workspaces.js'
import { listSources } from '../../lib/prospectSources.js'
import { dollarsToCents } from '../../lib/money.js'
import { escCsv } from '../../lib/csv.js'
import { clampInt } from '../../lib/validation.js'
import { normalizeDomain, withDollars, getICP } from './helpers.js'
import { parseQuery, workspaceIdField } from '../../lib/validate.js'
import { z } from 'zod'

// GET / query. Mirrors the prior raw parsing exactly:
//  - workspaceId required (else 400)
//  - page = Math.max(1, parseInt(page) || 1)
//  - limit = Math.min(100, parseInt(limit) || 25)  (note: NO lower clamp, so a
//    negative parseInt is preserved as-is — kept identical on purpose)
//  - tier/stage/outcome/search: passed through untouched (string | undefined)
//  - showExamples: true only when the literal string 'true'
const intFromQuery = (fallback: number) =>
  z.unknown().optional().transform(v => {
    const n = parseInt(v as string)
    return Number.isNaN(n) ? fallback : (n || fallback)
  })
const listProspectsQuerySchema = z.object({
  workspaceId: workspaceIdField,
  page: intFromQuery(1).transform(n => Math.max(1, n)),
  // Clamp to [1, 100]: a negative parseInt would otherwise reach Prisma's `take`
  // and silently REVERSE ordering (a negative take reads from the end).
  limit: intFromQuery(25).transform(n => Math.min(100, Math.max(1, n))),
  tier: z.string().optional(),
  stage: z.string().optional(),
  outcome: z.string().optional(),
  search: z.string().optional(),
  showExamples: z.unknown().optional().transform(v => v === 'true'),
})

export function registerCrudRoutes(prospectsRouter: Router) {
  // GET /api/prospects?workspaceId=&tier=&stage=&outcome=&search=&page=&limit=
  prospectsRouter.get('/', asyncHandler(async (req, res) => {
    const {
      workspaceId, page, limit,
      tier: tierFilter, stage: stageFilter, outcome: outcomeFilter, search,
      showExamples,
    } = parseQuery(listProspectsQuerySchema, req)

    const userId = req.user!.id
    if (!await userHasWorkspaceAccess(userId, workspaceId)) throw new ApiError(403, 'Access denied')

    const skip  = (page - 1) * limit

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
    const userId = req.user!.id
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
    const user = req.user!
    const workspaceId = String(req.query.workspaceId || '').trim()
    if (!workspaceId) throw new ApiError(400, 'workspaceId required')

    await assertMinimumWorkspaceRole(user.id, workspaceId, 'admin')

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

  // GET /api/prospects/intents?workspaceId= — workspace-level "this week's
  // outreach": actionable intents (not yet sent/closed) joined with their prospect,
  // ordered by opportunity score. Powers the Top-opportunities dashboard.
  // Registered before /:id so "intents" isn't matched as a prospect id.
  prospectsRouter.get('/intents', asyncHandler(async (req, res) => {
    const workspaceId = String(req.query.workspaceId || '').trim()
    if (!workspaceId) throw new ApiError(400, 'workspaceId required')
    const userId = req.user!.id
    if (!await userHasWorkspaceAccess(userId, workspaceId)) throw new ApiError(403, 'Access denied')

    const limit = clampInt(req.query.limit, { min: 1, max: 100, fallback: 25 })
    const intents = await prisma.outreachIntent.findMany({
      where: { workspaceId, status: { in: ['PROPOSED', 'DRAFTED', 'APPROVED'] } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        prospect: { select: { id: true, companyName: true, industry: true, location: true, opportunityScore: true, buyingStage: true } },
        recommendation: { select: { reasoning: true, actionText: true, urgency: true, priority: true } },
      },
    })
    // Surface the strongest opportunities first.
    intents.sort((a: { prospect?: { opportunityScore?: number | null } | null }, b: { prospect?: { opportunityScore?: number | null } | null }) => (b.prospect?.opportunityScore ?? 0) - (a.prospect?.opportunityScore ?? 0))
    res.json({ intents })
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

    const userId = req.user!.id
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

  // POST /api/prospects
  prospectsRouter.post('/', asyncHandler(async (req, res) => {
    const workspaceId = req.body.workspaceId as string
    if (!workspaceId)          throw new ApiError(400, 'workspaceId required')
    if (!req.body.companyName) throw new ApiError(400, 'companyName required')

    const userId = req.user!.id
    await assertMinimumWorkspaceRole(userId, workspaceId, 'admin')

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

    const userId = req.user!.id
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

    const userId = req.user!.id
    await assertMinimumWorkspaceRole(userId, existing.workspaceId, 'admin')

    await prisma.prospect.delete({ where: { id: req.params.id as string } })
    res.json({ ok: true })
  }))
}
