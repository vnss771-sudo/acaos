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
import { userHasWorkspaceAccess, assertMinimumWorkspaceRole } from '../lib/workspaces.js'
import { enqueueScoreProspects, enqueueCalibrate } from '../lib/queues.js'
import { enrichProspect } from '../services/apollo.js'
import { ingestSignal } from '../lib/signalIngest.js'
import { evidenceGatedPriority } from '../lib/recommendationPolicy.js'
import { createOutreachIntentForRecommendation, buildIntentDraftInput } from '../lib/outreachIntent.js'
import { materializeOutreachIntent } from '../lib/materializeIntent.js'
import { generateOutreach } from '../services/openai.js'
import { listSources, getSource, type ProspectCandidate } from '../lib/prospectSources.js'
import { getPack } from '../lib/packs/index.js'
import { findContactEmail, isHunterConfigured } from '../services/hunter.js'
import { dollarsToCents, centsToDollars } from '../lib/money.js'
import { escCsv } from '../lib/csv.js'
import { validate, workspaceIdField } from '../lib/validate.js'
import { z } from 'zod'
import type { AuthedRequest } from '../types/auth.js'
import type { Assert, Extends, DiscoverProspectsRequest } from '@acaos/shared'

export const prospectsRouter = Router()
prospectsRouter.use(requireAuth)

// Request contract for POST /discover, pinned to the shared type so they can't drift.
const discoverSchema = z.object({
  workspaceId: workspaceIdField,
  source: z.string().optional(),
  missionId: z.string().nullish(),
  industries: z.array(z.string()).optional(),
  locations: z.array(z.string()).optional(),
  keywords: z.array(z.string()).optional(),
  minEmployees: z.number().int().optional(),
  maxEmployees: z.number().int().optional(),
  limit: z.number().int().optional(),
})
type _DiscoverConforms = Assert<Extends<z.infer<typeof discoverSchema>, DiscoverProspectsRequest>>

/** An array, or undefined when it's missing/empty — for layered ICP fallbacks. */
function nonEmpty<T>(arr: T[] | null | undefined): T[] | undefined {
  return arr && arr.length > 0 ? arr : undefined
}

export function normalizeDomain(domain: string | null | undefined): string | null {
  if (!domain) return null
  return domain.toLowerCase().replace(/^www\./, '')
}

// Load an OutreachIntent for a write action: verifies the prospect exists, the
// caller has workspace access, and the intent belongs to that prospect.
async function loadIntentForWrite(prospectId: string, intentId: string, userId: string) {
  const prospect = await prisma.prospect.findUnique({ where: { id: prospectId }, select: { id: true, workspaceId: true } })
  if (!prospect) throw new ApiError(404, 'Prospect not found')
  await assertMinimumWorkspaceRole(userId, prospect.workspaceId, 'admin')
  const intent = await prisma.outreachIntent.findUnique({ where: { id: intentId } })
  if (!intent || intent.prospectId !== prospect.id) throw new ApiError(404, 'Outreach intent not found')
  return intent
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
  const userId = (req as AuthedRequest).user.id
  if (!await userHasWorkspaceAccess(userId, workspaceId)) throw new ApiError(403, 'Access denied')

  const limit = Math.min(Number(req.query.limit ?? 25), 100)
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
  intents.sort((a, b) => (b.prospect?.opportunityScore ?? 0) - (a.prospect?.opportunityScore ?? 0))
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

// POST /api/prospects/discover — pull companies from a source using the workspace
// ICP, falling back to the mission's playbook preset when scoped to a mission.
prospectsRouter.post('/discover', requireVerifiedEmail, validate(discoverSchema), asyncHandler(async (req, res) => {
  const body = req.body as z.infer<typeof discoverSchema>
  const workspaceId = body.workspaceId

  const userId = (req as AuthedRequest).user.id
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
  const limit = Math.min(Number(body.limit ?? 25), 50)

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
prospectsRouter.post('/import', requireVerifiedEmail, asyncHandler(async (req, res) => {
  const workspaceId = req.body.workspaceId as string
  if (!workspaceId) throw new ApiError(400, 'workspaceId required')
  const rows: Record<string, unknown>[] = req.body.rows
  if (!Array.isArray(rows) || rows.length === 0) throw new ApiError(400, 'rows array required')
  if (rows.length > 1000) throw new ApiError(400, 'Maximum 1000 rows per import')

  const userId = (req as AuthedRequest).user.id
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
const IMPORT_SIGNAL_TYPES = new Set<SignalType>([
  'HIRING', 'FUNDING', 'EXPANSION', 'TECH_ADOPTION', 'LEADERSHIP_CHANGE',
  'NEWS_MENTION', 'PROCUREMENT', 'BUSINESS_REGISTRATION', 'WEBSITE_CHANGE',
])

prospectsRouter.post('/import-signals', requireVerifiedEmail, asyncHandler(async (req, res) => {
  const workspaceId = String(req.body?.workspaceId || '').trim()
  if (!workspaceId) throw new ApiError(400, 'workspaceId required')
  const rows: Record<string, unknown>[] = req.body?.rows
  if (!Array.isArray(rows) || rows.length === 0) throw new ApiError(400, 'rows array required')
  if (rows.length > 500) throw new ApiError(400, 'Maximum 500 rows per import')

  const userId = (req as AuthedRequest).user.id
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

// POST /api/prospects
prospectsRouter.post('/', asyncHandler(async (req, res) => {
  const workspaceId = req.body.workspaceId as string
  if (!workspaceId)          throw new ApiError(400, 'workspaceId required')
  if (!req.body.companyName) throw new ApiError(400, 'companyName required')

  const userId = (req as AuthedRequest).user.id
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
  await assertMinimumWorkspaceRole(userId, existing.workspaceId, 'admin')

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

  // Evidence-first gate: high-confidence priority requires provable, fresh
  // evidence on a signal — otherwise it's capped below the high-confidence line.
  const priority = evidenceGatedPriority(rec.priority, prospect.signals)

  const recommendation = await prisma.recommendation.create({
    data: {
      workspaceId: prospect.workspaceId,
      prospectId:  prospect.id,
      ...rec,
      priority,
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
    },
  })

  // Bridge (Stage 2): carry this recommendation into the outreach spine as an
  // OutreachIntent with an evidence snapshot. Best-effort — additive.
  await createOutreachIntentForRecommendation({
    workspaceId: prospect.workspaceId,
    prospectId:  prospect.id,
    recommendationId: recommendation.id,
    messageAngle: rec.messageAngle,
    channel: rec.bestChannel,
    signals: prospect.signals,
    missionId: prospect.missionId,
  }).catch(() => {})

  res.status(201).json(recommendation)
}))

// GET /api/prospects/:id/intents — read-only view of the bridge records for a
// prospect (Stage 2): recommendation → outreach intent with evidence snapshot.
prospectsRouter.get('/:id/intents', asyncHandler(async (req, res) => {
  const prospect = await prisma.prospect.findUnique({
    where: { id: req.params.id as string },
    select: { id: true, workspaceId: true },
  })
  if (!prospect) throw new ApiError(404, 'Prospect not found')

  const userId = (req as AuthedRequest).user.id
  if (!await userHasWorkspaceAccess(userId, prospect.workspaceId)) throw new ApiError(403, 'Access denied')

  const intents = await prisma.outreachIntent.findMany({
    where: { prospectId: prospect.id },
    orderBy: { createdAt: 'desc' },
  })
  res.json({ intents })
}))

// POST /api/prospects/:id/intents/:intentId/draft — Stage 3: generate the
// outreach draft FROM the intent's evidence context and store it on the intent.
prospectsRouter.post('/:id/intents/:intentId/draft', asyncHandler(async (req, res) => {
  const prospect = await prisma.prospect.findUnique({
    where: { id: req.params.id as string },
    select: { id: true, workspaceId: true, companyName: true, industry: true, contactName: true, location: true },
  })
  if (!prospect) throw new ApiError(404, 'Prospect not found')

  const userId = (req as AuthedRequest).user.id
  await assertMinimumWorkspaceRole(userId, prospect.workspaceId, 'admin')

  const intent = await prisma.outreachIntent.findUnique({ where: { id: req.params.intentId as string } })
  if (!intent || intent.prospectId !== prospect.id) throw new ApiError(404, 'Outreach intent not found')

  const [recommendation, icpRow, missionCtx] = await Promise.all([
    intent.recommendationId
      ? prisma.recommendation.findUnique({ where: { id: intent.recommendationId }, select: { reasoning: true, messageAngle: true } })
      : Promise.resolve(null),
    prisma.workspaceICP.findUnique({ where: { workspaceId: prospect.workspaceId }, select: { targetIndustries: true, businessType: true, outreachTone: true } }),
    // Per-mission override (offer + target customer) when the intent belongs to a mission.
    intent.missionId
      ? prisma.mission.findUnique({ where: { id: intent.missionId }, select: { targetCustomer: true, offer: true } })
      : Promise.resolve(null),
  ])
  const icp = (icpRow || missionCtx)
    ? {
        targetIndustries: icpRow?.targetIndustries,
        businessType: icpRow?.businessType ?? undefined,
        outreachTone: icpRow?.outreachTone ?? undefined,
        offer: missionCtx?.offer ?? undefined,
        targetCustomer: missionCtx?.targetCustomer ?? undefined,
      }
    : undefined

  const raw = await generateOutreach(buildIntentDraftInput({ prospect, recommendation, intent, icp }))
  let parsed: { subject?: string; email?: string; followup?: string }
  try { parsed = JSON.parse(raw) } catch { throw new ApiError(502, 'AI returned an invalid draft') }

  const updated = await prisma.outreachIntent.update({
    where: { id: intent.id },
    data: {
      draftSubject: parsed.subject ?? null,
      draftBody: parsed.email ?? null,
      draftFollowup: parsed.followup ?? null,
      draftGeneratedAt: new Date(),
      status: 'DRAFTED',
    },
  })
  res.json(updated)
}))

// Stage 4: approve/reject an intent's drafted outreach. Approval locks the
// evidence + text already captured on the intent (the auditable snapshot).
prospectsRouter.post('/:id/intents/:intentId/approve', asyncHandler(async (req, res) => {
  const userId = (req as AuthedRequest).user.id
  const intent = await loadIntentForWrite(req.params.id as string, req.params.intentId as string, userId)
  if (intent.status !== 'DRAFTED') {
    throw new ApiError(409, `Cannot approve an intent that is ${intent.status.toLowerCase()} — generate a draft first`)
  }
  // Optionally link the intent to a lead so the send path can stamp its
  // provenance onto the resulting OutreachSent (Stage 5).
  const leadId = typeof req.body?.leadId === 'string' ? req.body.leadId.trim() : undefined
  if (leadId) {
    const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { workspaceId: true } })
    if (!lead || lead.workspaceId !== intent.workspaceId) throw new ApiError(400, 'leadId does not belong to this workspace')
  }
  const updated = await prisma.outreachIntent.update({
    where: { id: intent.id },
    data: { status: 'APPROVED', approvedBy: userId, approvedAt: new Date(), ...(leadId ? { leadId } : {}) },
  })
  void recordAudit({
    workspaceId: intent.workspaceId, actorUserId: userId,
    type: 'outreachIntent.approve', entityType: 'outreachIntent', entityId: intent.id,
    metadata: { prospectId: intent.prospectId },
  })
  res.json(updated)
}))

prospectsRouter.post('/:id/intents/:intentId/reject', asyncHandler(async (req, res) => {
  const userId = (req as AuthedRequest).user.id
  const intent = await loadIntentForWrite(req.params.id as string, req.params.intentId as string, userId)
  if (['SENT', 'WON', 'LOST'].includes(intent.status)) {
    throw new ApiError(409, `Cannot reject a ${intent.status.toLowerCase()} intent`)
  }
  const updated = await prisma.outreachIntent.update({ where: { id: intent.id }, data: { status: 'REJECTED' } })
  void recordAudit({
    workspaceId: intent.workspaceId, actorUserId: userId,
    type: 'outreachIntent.reject', entityType: 'outreachIntent', entityId: intent.id,
    metadata: { prospectId: intent.prospectId },
  })
  res.json(updated)
}))

// Stage 5 / Option A: materialise an APPROVED intent into a sendable Lead +
// APPROVED draft in a campaign, linked back to the intent. After this, launch
// the campaign via the normal send path (which stamps provenance + flips SENT).
prospectsRouter.post('/:id/intents/:intentId/materialize', asyncHandler(async (req, res) => {
  const userId = (req as AuthedRequest).user.id
  const intent = await loadIntentForWrite(req.params.id as string, req.params.intentId as string, userId)
  if (intent.status !== 'APPROVED') {
    throw new ApiError(409, `Intent must be approved before sending — it is ${intent.status.toLowerCase()}`)
  }
  if (!intent.draftBody) throw new ApiError(409, 'Intent has no drafted message to send')

  const prospect = await prisma.prospect.findUnique({
    where: { id: intent.prospectId },
    select: { companyName: true, contactEmail: true, contactName: true, domain: true, location: true, industry: true },
  })
  if (!prospect) throw new ApiError(404, 'Prospect not found')
  if (!prospect.contactEmail) throw new ApiError(400, 'Prospect has no contact email — cannot create a sendable lead')

  const campaignId = typeof req.body?.campaignId === 'string' ? req.body.campaignId.trim() : undefined
  if (campaignId) {
    const c = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { workspaceId: true } })
    if (!c || c.workspaceId !== intent.workspaceId) throw new ApiError(400, 'campaignId does not belong to this workspace')
  }

  const result = await materializeOutreachIntent({ intent, prospect, campaignId })
  void recordAudit({
    workspaceId: intent.workspaceId, actorUserId: userId,
    type: 'outreachIntent.materialize', entityType: 'outreachIntent', entityId: intent.id,
    metadata: result,
  })
  res.status(201).json({ ...result, message: `Intent materialised — launch campaign ${result.campaignId} to send (approval-mode safe).` })
}))

// POST /api/prospects/:id/enrich — Apollo.io enrichment → auto signals → rescore
prospectsRouter.post('/:id/enrich', asyncHandler(async (req, res) => {
  const prospect = await prisma.prospect.findUnique({ where: { id: req.params.id as string } })
  if (!prospect) throw new ApiError(404, 'Prospect not found')

  const userId = (req as AuthedRequest).user.id
  await assertMinimumWorkspaceRole(userId, prospect.workspaceId, 'admin')

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
