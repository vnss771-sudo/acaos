import type { Router } from 'express'
import { requireVerifiedEmail } from '../../middleware/auth.js'
import { requireFeature } from '../../middleware/featureGate.js'
import { asyncHandler, ApiError } from '../../lib/http.js'
import { recordAudit } from '../../lib/audit.js'
import { checkAndIncrementDiscoveryUsage } from '../../lib/limits.js'
import { prisma } from '../../lib/prisma.js'
import {
  calculateOpportunityScores,
  detectBuyingStage,
  calcWinProbability,
  type SignalType,
} from '../../lib/signalEngine.js'
import { assertMinimumWorkspaceRole } from '../../lib/workspaces.js'
import { enqueueScoreProspects, enqueueDiscoverProspects } from '../../lib/queues.js'
import { ingestSignal } from '../../lib/signalIngest.js'
import { listSources, getSource } from '../../lib/prospectSources.js'
import { getPack } from '../../lib/packs/index.js'
import { createHash } from 'node:crypto'
import { dollarsToCents } from '../../lib/money.js'
import { validate } from '../../lib/validate.js'
import { z } from 'zod'
import { discoverSchema, nonEmpty, normalizeDomain, normalizeCompanyNameKey, normalizeEmailKey, getICP, IMPORT_SIGNAL_TYPES } from './helpers.js'
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
  prospectsRouter.post('/discover', requireVerifiedEmail, requireFeature('discovery'), validate(discoverSchema), asyncHandler(async (req, res) => {
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

    // Stable hash of (source + canonical query) for in-flight dedup. Sorting the
    // array fields + fixing key order makes the hash insensitive to request-order
    // noise so two equivalent requests collapse onto the same run.
    const canonicalQuery = JSON.stringify({
      source: sourceName,
      industries: [...query.industries].sort(),
      locations: [...query.locations].sort(),
      keywords: [...query.keywords].sort(),
      minEmployees: query.minEmployees ?? null,
      maxEmployees: query.maxEmployees ?? null,
      limit: query.limit,
      missionId,
    })
    const queryHash = createHash('sha256').update(canonicalQuery).digest('hex')

    // Dedup: if an identical run is already in flight (RUNNING in the last 10
    // minutes), return it instead of starting a duplicate provider search +
    // double-charging quota. The worker is the single executor.
    const inflightSince = new Date(Date.now() - 10 * 60_000)
    const existingRun = await prisma.discoveryRun.findFirst({
      where: { workspaceId, queryHash, status: 'RUNNING', startedAt: { gte: inflightSince } },
      orderBy: { startedAt: 'desc' },
      select: { id: true },
    })
    if (existingRun) {
      return res.status(202).json({ runId: existingRun.id, status: 'RUNNING', deduped: true })
    }

    // Enforce the per-workspace monthly discovery quota (cost/abuse control on
    // platform-level provider keys). Throws 429 when the plan cap is reached.
    // Only after dedup, so a deduped request doesn't burn a second unit.
    await checkAndIncrementDiscoveryUsage(workspaceId)

    // Create the run (RUNNING) and hand the actual provider search + import to the
    // discover-prospects worker, returning 202 immediately so a slow/flaky provider
    // can never time out the request or leave a half-finished synchronous run.
    const run = await prisma.discoveryRun.create({
      data: { workspaceId, missionId, source: sourceName, status: 'RUNNING', query, queryHash },
      select: { id: true },
    })

    const job = await enqueueDiscoverProspects(run.id, workspaceId)

    void recordAudit({
      workspaceId, actorUserId: userId, type: 'discovery.enqueued',
      entityType: 'discoveryRun', entityId: run.id, metadata: { source: sourceName, jobId: job.id },
    })

    res.status(202).json({
      runId: run.id,
      jobId: job.id,
      queue: 'discover-prospects',
      status: 'RUNNING',
      message: `Discovery via ${source.label} started. Poll GET /api/prospects/discovery-runs?workspaceId=${workspaceId} for status.`,
    })
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
            companyNameKey: normalizeCompanyNameKey(companyName),
            emailKey:      normalizeEmailKey(meta.contactEmail),
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
              companyNameKey: normalizeCompanyNameKey(companyName),
              emailKey: normalizeEmailKey(row.contactEmail ? String(row.contactEmail) : null),
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
