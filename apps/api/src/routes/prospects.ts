import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import {
  calculateOpportunityScores,
  calculateExpectedRevenue,
  detectBuyingStage,
  calcWinProbability,
  generateRuleBasedRecommendation,
  getOpportunityTier,
  predictBuyingIntent,
  normalizeSignal,
  toRawSignal,
  computeSignalExpiry,
  type ICPConfig,
} from '../lib/signalEngine.js'
import { userHasWorkspaceAccess } from '../lib/workspaces.js'
import { enqueueScoreProspects, enqueueCalibrate, enqueueAdvanceCadence } from '../lib/queues.js'
import type { AuthedRequest } from '../types/auth.js'

export const prospectsRouter = Router()
prospectsRouter.use(requireAuth)

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
  const sortBy        = req.query.sortBy  as string | undefined  // opportunityScore | expectedRevenueScore

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

  const orderBy = sortBy === 'expectedRevenueScore'
    ? { expectedRevenueScore: 'desc' as const }
    : { opportunityScore: 'desc' as const }

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
        winProbability: true, retentionProbability: true, expansionProbability: true,
        expectedRevenueScore: true,
        lastSignalAt: true, lastContactedAt: true,
        sourceTag: true, createdAt: true, updatedAt: true,
        _count: { select: { signals: true } },
        recommendations: { orderBy: { priority: 'desc' }, take: 1 },
      },
      orderBy,
      skip,
      take: limit + 1,
    }),
    prisma.prospect.count({ where }),
  ])

  const hasMore = prospects.length > limit
  if (hasMore) prospects.pop()

  res.json({
    prospects: prospects.map((p: (typeof prospects)[0]) => ({
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

// GET /api/prospects/:id
prospectsRouter.get('/:id', asyncHandler(async (req, res) => {
  const prospect = await prisma.prospect.findUnique({
    where: { id: req.params.id },
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

  res.json({ ...prospect, tier: getOpportunityTier(prospect.opportunityScore), prediction })
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

  const icp          = await getICP(workspaceId)
  const scores       = calculateOpportunityScores([], meta, icp)
  const buyingStage  = detectBuyingStage([], scores.opportunityScore)
  const winProbability = calcWinProbability(buyingStage, scores.opportunityScore)
  const expectedDealValue = req.body.expectedDealValue ? Number(req.body.expectedDealValue) : null
  const expectedRevenueScore = calculateExpectedRevenue(winProbability, expectedDealValue)

  const created = await prisma.prospect.create({
    data: {
      workspaceId,
      companyName:       req.body.companyName,
      domain:            meta.domain,
      industry:          meta.industry,
      employeeCount:     meta.employeeCount,
      estimatedRevenue:  req.body.estimatedRevenue  ? Number(req.body.estimatedRevenue)  : null,
      location:          meta.location,
      description:       req.body.description   ?? null,
      notes:             req.body.notes          ?? null,
      aiSummary:         req.body.aiSummary      ?? null,
      contactName:       meta.contactName,
      contactEmail:      meta.contactEmail,
      contactPhone:      req.body.contactPhone   ?? null,
      contactTitle:      req.body.contactTitle   ?? null,
      linkedinUrl:       req.body.linkedinUrl    ?? null,
      expectedDealValue,
      sourceTag:         req.body.sourceTag      ?? null,
      ...scores,
      buyingStage,
      winProbability,
      expectedRevenueScore,
    },
  })

  res.status(201).json({ ...created, tier: getOpportunityTier(created.opportunityScore) })
}))

// PATCH /api/prospects/:id
prospectsRouter.patch('/:id', asyncHandler(async (req, res) => {
  const existing = await prisma.prospect.findUnique({ where: { id: req.params.id } })
  if (!existing) throw new ApiError(404, 'Prospect not found')

  const userId = (req as AuthedRequest).user.id
  if (!await userHasWorkspaceAccess(userId, existing.workspaceId)) throw new ApiError(403, 'Access denied')

  const allowed = [
    'companyName', 'domain', 'industry', 'employeeCount', 'estimatedRevenue',
    'location', 'description', 'notes', 'aiSummary',
    'contactName', 'contactEmail', 'contactPhone', 'contactTitle',
    'linkedinUrl', 'outcomeStage', 'buyingStage', 'expectedDealValue', 'sourceTag',
  ]

  const data: Record<string, unknown> = {}
  for (const key of allowed) {
    if (req.body[key] !== undefined) data[key] = req.body[key]
  }
  if (req.body.lastContactedAt) data.lastContactedAt = new Date(req.body.lastContactedAt)

  const updated = await prisma.prospect.update({ where: { id: req.params.id }, data })
  res.json({ ...updated, tier: getOpportunityTier(updated.opportunityScore) })
}))

// DELETE /api/prospects/:id
prospectsRouter.delete('/:id', asyncHandler(async (req, res) => {
  const existing = await prisma.prospect.findUnique({ where: { id: req.params.id } })
  if (!existing) throw new ApiError(404, 'Prospect not found')

  const userId = (req as AuthedRequest).user.id
  if (!await userHasWorkspaceAccess(userId, existing.workspaceId)) throw new ApiError(403, 'Access denied')

  await prisma.prospect.delete({ where: { id: req.params.id } })
  res.json({ ok: true })
}))

// POST /api/prospects/:id/rescore
prospectsRouter.post('/:id/rescore', asyncHandler(async (req, res) => {
  const prospect = await prisma.prospect.findUnique({
    where: { id: req.params.id },
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
  const buyingStage         = detectBuyingStage(rawSignals, scores.opportunityScore)
  const winProbability      = calcWinProbability(buyingStage, scores.opportunityScore)
  const expectedRevenueScore = calculateExpectedRevenue(
    winProbability,
    prospect.expectedDealValue,
    prospect.retentionProbability,
    prospect.expansionProbability,
  )

  const updated = await prisma.prospect.update({
    where: { id: req.params.id },
    data: { ...scores, buyingStage, winProbability, expectedRevenueScore },
  })
  res.json({ ...updated, tier: getOpportunityTier(updated.opportunityScore) })
}))

// POST /api/prospects/:id/outcome
prospectsRouter.post('/:id/outcome', asyncHandler(async (req, res) => {
  const prospect = await prisma.prospect.findUnique({ where: { id: req.params.id } })
  if (!prospect) throw new ApiError(404, 'Prospect not found')

  const userId = (req as AuthedRequest).user.id
  if (!await userHasWorkspaceAccess(userId, prospect.workspaceId)) throw new ApiError(403, 'Access denied')

  const VALID_OUTCOME_STAGES = ['DISCOVERED', 'VIEWED', 'CONTACTED', 'MEETING', 'PROPOSAL', 'WON', 'LOST']
  if (!req.body.stage) throw new ApiError(400, 'stage required')
  if (!VALID_OUTCOME_STAGES.includes(req.body.stage)) {
    throw new ApiError(400, `stage must be one of: ${VALID_OUTCOME_STAGES.join(', ')}`)
  }

  const [outcome, updated] = await prisma.$transaction([
    prisma.prospectOutcome.create({
      data: {
        workspaceId: prospect.workspaceId,
        prospectId:  prospect.id,
        stage:       req.body.stage,
        notes:       req.body.notes     ?? null,
        dealValue:   req.body.dealValue ? Number(req.body.dealValue) : null,
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

  res.json({ outcome, prospect: { ...updated, tier: getOpportunityTier(updated.opportunityScore) } })
}))

// POST /api/prospects/:id/recommend
prospectsRouter.post('/:id/recommend', asyncHandler(async (req, res) => {
  const prospect = await prisma.prospect.findUnique({
    where: { id: req.params.id },
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
    rawSignals,
    prospect.winProbability ?? 0,
  )

  const expectedRevenue = calculateExpectedRevenue(
    prospect.winProbability,
    prospect.expectedDealValue,
    prospect.retentionProbability,
    prospect.expansionProbability,
  )

  const recommendation = await prisma.recommendation.create({
    data: {
      workspaceId:        prospect.workspaceId,
      prospectId:         prospect.id,
      ...rec,
      expectedRevenue,
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
    },
  })

  res.status(201).json(recommendation)
}))

// POST /api/prospects/:id/enrich — Apollo.io enrichment → auto signals → rescore
prospectsRouter.post('/:id/enrich', asyncHandler(async (req, res) => {
  const prospect = await prisma.prospect.findUnique({ where: { id: req.params.id } })
  if (!prospect) throw new ApiError(404, 'Prospect not found')

  const userId = (req as AuthedRequest).user.id
  if (!await userHasWorkspaceAccess(userId, prospect.workspaceId)) throw new ApiError(403, 'Access denied')

  const { enrichProspect } = await import('../services/apollo.js')

  // Fetch existing signals and ICP concurrently before enrichment writes
  const [existingSignals, icp] = await Promise.all([
    prisma.signal.findMany({ where: { prospectId: prospect.id } }),
    getICP(prospect.workspaceId),
  ])

  const result = await enrichProspect(prospect)

  // Create all new signals in parallel — enrich with normalization data and expiry
  const newSignals = await Promise.all(
    result.signals.map(sig => {
      const { normalizedType, category, buyingImplication, predictedNeeds } = normalizeSignal(sig.type)
      return prisma.signal.create({
        data: {
          workspaceId:       prospect.workspaceId,
          prospectId:        prospect.id,
          type:              sig.type as import('@prisma/client').SignalType,
          rawType:           sig.type,
          normalizedType,
          category,
          buyingImplication,
          predictedNeeds,
          strength:          sig.strength,
          confidence:        sig.sourceReliability,
          sourceReliability: sig.sourceReliability,
          industryRelevance: sig.industryRelevance,
          title:             sig.title,
          description:       sig.description,
          source:            sig.source,
          detectedAt:        sig.detectedAt,
          expiresAt:         computeSignalExpiry(sig.type, sig.detectedAt),
        },
      })
    })
  )
  const created = newSignals.map(s => s.id)

  const allSignals = [...existingSignals, ...newSignals]
  const rawSignals = allSignals.map(toRawSignal)

  const u = result.updates
  // Apply allowlist — never blindly spread external data into Prisma
  const ALLOWED_ENRICH = ['industry', 'employeeCount', 'contactEmail', 'contactName',
    'contactPhone', 'contactTitle', 'linkedinUrl', 'domain', 'description', 'location'] as const
  const safeUpdates: Record<string, unknown> = {}
  for (const key of ALLOWED_ENRICH) {
    if (u[key] !== undefined) safeUpdates[key] = u[key]
  }

  const scores = calculateOpportunityScores(rawSignals, {
    industry:      u.industry      ?? prospect.industry,
    employeeCount: u.employeeCount ?? prospect.employeeCount,
    contactEmail:  u.contactEmail  ?? prospect.contactEmail,
    contactName:   u.contactName   ?? prospect.contactName,
    domain:        u.domain        ?? prospect.domain,
    location:      prospect.location,
  }, icp)
  const buyingStage          = detectBuyingStage(rawSignals, scores.opportunityScore)
  const winProbability       = calcWinProbability(buyingStage, scores.opportunityScore)
  const expectedRevenueScore = calculateExpectedRevenue(
    winProbability,
    prospect.expectedDealValue,
    prospect.retentionProbability,
    prospect.expansionProbability,
  )

  const latestSignalAt = allSignals.reduce<Date | null>((max, s) => {
    return !max || s.detectedAt > max ? s.detectedAt : max
  }, null)

  const updated = await prisma.prospect.update({
    where: { id: prospect.id },
    data: {
      ...scores,
      buyingStage,
      winProbability,
      expectedRevenueScore,
      ...(latestSignalAt && { lastSignalAt: latestSignalAt }),
      ...(Object.keys(safeUpdates).length > 0 && safeUpdates),
    },
  })

  res.json({
    prospect:       { ...updated, tier: getOpportunityTier(updated.opportunityScore) },
    signalsCreated: created.length,
    signalIds:      created
  })
}))

// POST /api/prospects/:id/outreach — generate (and optionally send) signal-aware outreach
prospectsRouter.post('/:id/outreach', asyncHandler(async (req, res) => {
  const prospect = await prisma.prospect.findUnique({
    where: { id: req.params.id },
    include: {
      signals:         { orderBy: { detectedAt: 'desc' }, take: 10 },
      recommendations: { orderBy: { priority: 'desc' }, take: 1 },
    },
  })
  if (!prospect) throw new ApiError(404, 'Prospect not found')

  const userId = (req as AuthedRequest).user.id
  if (!await userHasWorkspaceAccess(userId, prospect.workspaceId)) throw new ApiError(403, 'Access denied')

  const send = req.body.send === true
  if (send && !prospect.contactEmail) throw new ApiError(422, 'Prospect has no contact email — cannot send')

  const { generateSignalAwareOutreach } = await import('../services/openai.js')
  const { isMailConfigured, sendMail }  = await import('../services/mail.js')

  const poaSignal = prospect.signals.find(s => s.type === 'PROBLEM_OWNER_ACTIVATION')
  const poaTier   = poaSignal?.title?.match(/\((POSSIBLE|PROBABLE|CONFIRMED)\)/)?.[1]

  const raw = await generateSignalAwareOutreach({
    businessName:     prospect.companyName,
    category:         prospect.industry    ?? undefined,
    city:             prospect.location    ?? undefined,
    contactName:      prospect.contactName ?? undefined,
    aiSummary:        prospect.aiSummary   ?? undefined,
    outreachAngle:    prospect.recommendations[0]?.messageAngle ?? undefined,
    signals:          prospect.signals.map(s => ({
      type: s.type, title: s.title, description: s.description, strength: s.strength,
    })),
    buyingStage:      prospect.buyingStage,
    opportunityScore: prospect.opportunityScore,
    poaActivated:     Boolean(poaSignal),
    poaTier,
    templateType:     (req.body.templateType as 'INITIAL' | 'FOLLOWUP_1' | 'FOLLOWUP_2') ?? 'INITIAL',
  })

  const parsed = JSON.parse(raw) as { subject?: string; email?: string; followup?: string }
  if (!parsed.subject || !parsed.email) throw new ApiError(502, 'AI failed to generate valid outreach')

  // Track AI usage
  const month = new Date().toISOString().slice(0, 7)
  await prisma.usageRecord.upsert({
    where: { workspaceId_month_action: { workspaceId: prospect.workspaceId, month, action: 'AI_OUTREACH' } },
    create: { workspaceId: prospect.workspaceId, month, action: 'AI_OUTREACH', count: 1 },
    update: { count: { increment: 1 } },
  })

  if (send) {
    if (!isMailConfigured()) throw new ApiError(503, 'SMTP is not configured')
    // Create the outcome record first so we have the ID for tracking injection
    const outcome = await prisma.messageOutcome.create({
      data: { workspaceId: prospect.workspaceId, prospectId: prospect.id, event: 'SENT', channel: 'EMAIL', sentAt: new Date() },
    })
    await sendMail(
      prospect.contactEmail!,
      parsed.subject,
      `<p style="font-family:sans-serif;line-height:1.6">${parsed.email.replace(/\n/g, '<br>')}</p>`,
      outcome.id
    )
    await prisma.prospect.update({
      where: { id: prospect.id },
      data:  { outcomeStage: 'CONTACTED', lastContactedAt: new Date() },
    })
  }

  res.status(send ? 200 : 201).json({
    subject:  parsed.subject,
    email:    parsed.email,
    followup: parsed.followup ?? null,
    sent:     send,
  })
}))

// POST /api/prospects/:id/enroll-cadence — enroll prospect in a multi-touch outreach sequence
prospectsRouter.post('/:id/enroll-cadence', asyncHandler(async (req, res) => {
  const prospect = await prisma.prospect.findUnique({ where: { id: req.params.id } })
  if (!prospect) throw new ApiError(404, 'Prospect not found')

  const userId = (req as AuthedRequest).user.id
  if (!await userHasWorkspaceAccess(userId, prospect.workspaceId)) throw new ApiError(403, 'Access denied')

  if (!prospect.contactEmail) throw new ApiError(422, 'Prospect has no contact email — cannot enroll in cadence')

  let cadenceId = req.body.cadenceId as string | undefined

  if (!cadenceId) {
    // Find or create the workspace default 3-step cadence
    let defaultCadence = await prisma.cadence.findFirst({
      where: { workspaceId: prospect.workspaceId, isDefault: true },
    })

    if (!defaultCadence) {
      defaultCadence = await prisma.cadence.create({
        data: {
          workspaceId: prospect.workspaceId,
          name:        'Default 3-Step Email Sequence',
          isDefault:   true,
          steps: [
            { dayOffset: 0,  channel: 'EMAIL', templateType: 'INITIAL'    },
            { dayOffset: 4,  channel: 'EMAIL', templateType: 'FOLLOWUP_1' },
            { dayOffset: 10, channel: 'EMAIL', templateType: 'FOLLOWUP_2' },
          ],
        },
      })
    }

    cadenceId = defaultCadence.id
  }

  // Upsert enrollment — idempotent so re-enrolling re-activates a paused sequence
  const enrollment = await prisma.cadenceEnrollment.upsert({
    where:  { prospectId_cadenceId: { prospectId: prospect.id, cadenceId } },
    create: {
      workspaceId: prospect.workspaceId,
      prospectId:  prospect.id,
      cadenceId,
      currentStep:  0,
      status:       'ACTIVE',
      nextActionAt: new Date(),
    },
    update: {
      status:       'ACTIVE',
      currentStep:  0,
      nextActionAt: new Date(),
      completedAt:  null,
    },
  })

  await enqueueAdvanceCadence(enrollment.id)

  res.status(201).json({ enrollment })
}))
