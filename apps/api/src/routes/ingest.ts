import { Router } from 'express'
import { asyncHandler, ApiError } from '../lib/http.js'
import { generateApiKey, hashApiKey } from '../lib/apiKeys.js'
import { prisma } from '../lib/prisma.js'
import { enqueueResearchLead } from '../lib/queues.js'
import { checkAndIncrementAiUsage, reserveLeadCapacity } from '../lib/limits.js'
import { requireAuth } from '../middleware/auth.js'
import { getCachedWorkspace, setCachedWorkspace, evictCachedWorkspace } from '../lib/ingestCache.js'
import { apiKeyRateLimit } from '../middleware/rateLimit.js'
import type { AuthedRequest } from '../types/auth.js'

export const ingestRouter = Router()

const MAX_BATCH = 500
const MAX_SHORT = 200

// ---------------------------------------------------------------------------
// API-key middleware — resolves workspace from x-api-key header
// ---------------------------------------------------------------------------
async function requireIngestKey(
  req: import('express').Request,
  res: import('express').Response,
  next: import('express').NextFunction
) {
  const key = req.headers['x-api-key']
  if (!key || typeof key !== 'string') {
    res.status(401).json({ error: 'Missing x-api-key header' })
    return
  }
  const hash = hashApiKey(key)
  let workspace = getCachedWorkspace(hash)
  if (!workspace) {
    const row = await prisma.workspace.findUnique({
      where: { ingestApiKey: hash },
      select: { id: true, plan: true }
    })
    if (!row) { res.status(401).json({ error: 'Invalid API key' }); return }
    setCachedWorkspace(hash, row)
    workspace = row
  }
  // Attach workspace so the route handler doesn't re-fetch it
  ;(req as import('express').Request & { ingestWorkspace: typeof workspace }).ingestWorkspace = workspace
  next()
}

// ---------------------------------------------------------------------------
// POST /api/ingest
// Called by autonomous lead gen systems — no user session required.
// Body: { leads: LeadInput[], campaignId?, sourceTag?, autoResearch? }
// ---------------------------------------------------------------------------
ingestRouter.post(
  '/',
  apiKeyRateLimit,
  requireIngestKey,
  asyncHandler(async (req, res) => {
    const workspace = (req as any).ingestWorkspace
    const { leads, campaignId, sourceTag, autoResearch = true } = req.body ?? {}

    if (!Array.isArray(leads) || leads.length === 0) throw new ApiError(400, 'leads array required')
    if (leads.length > MAX_BATCH) throw new ApiError(400, `Maximum ${MAX_BATCH} leads per request`)
    if (sourceTag && typeof sourceTag !== 'string') throw new ApiError(400, 'sourceTag must be a string')
    const tag = typeof sourceTag === 'string' ? sourceTag.trim().slice(0, 100) || null : null

    // Validate campaignId belongs to this workspace
    if (campaignId) {
      const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, workspaceId: workspace.id } })
      if (!campaign) throw new ApiError(400, 'campaignId not found in workspace')
    }

    // Collect emails from the incoming batch for deduplication
    const incomingEmails = leads
      .map((l: any) => (typeof l?.email === 'string' ? l.email.trim().toLowerCase() : null))
      .filter(Boolean) as string[]

    // Find which emails already exist in this workspace
    const existing = incomingEmails.length
      ? await prisma.lead.findMany({
          where: { workspaceId: workspace.id, email: { in: incomingEmails } },
          select: { email: true }
        })
      : []
    const existingEmails = new Set((existing as Array<{ email: string | null }>).map((l: { email: string | null }) => l.email!.toLowerCase()))

    // Deduplicate the batch itself (first occurrence wins)
    const seenEmails = new Set<string>()
    const rows: any[] = []

    for (const l of leads) {
      if (typeof l?.businessName !== 'string' || !l.businessName.trim()) continue
      const email = typeof l.email === 'string' ? l.email.trim().toLowerCase() || null : null

      if (email) {
        if (existingEmails.has(email) || seenEmails.has(email)) continue
        seenEmails.add(email)
      }

      rows.push({
        workspaceId: workspace.id,
        campaignId: campaignId ?? null,
        sourceTag: tag,
        businessName: String(l.businessName).trim().slice(0, MAX_SHORT),
        contactName: typeof l.contactName === 'string' ? l.contactName.trim() || null : null,
        email,
        phone: typeof l.phone === 'string' ? l.phone.trim() || null : null,
        website: typeof l.website === 'string' ? l.website.trim() || null : null,
        city: typeof l.city === 'string' ? l.city.trim() || null : null,
        category: typeof l.category === 'string' ? l.category.trim() || null : null,
        notes: typeof l.notes === 'string' ? l.notes.trim().slice(0, 2000) || null : null,
        score: Number(l.score) || 0
      })
    }

    if (rows.length === 0) {
      return res.json({ created: 0, skipped: leads.length, queued: 0 })
    }

    // Insert new leads one-by-one so we get their IDs for queue jobs. The
    // insert runs inside a transaction that first reserves plan capacity under a
    // per-workspace lock, so an ingest key cannot exceed the workspace's lead
    // cap (rows beyond the remaining quota are truncated and reported as skipped).
    const created = await prisma.$transaction(async (tx) => {
      const allowed = await reserveLeadCapacity(tx, workspace.id, rows.length)
      const out = []
      for (const data of rows.slice(0, allowed)) {
        out.push(await tx.lead.create({ data }))
      }
      return out
    })

    // Enqueue AI research for each new lead if requested — subject to the same
    // monthly AI plan limit as the dashboard, so the ingest key cannot drive
    // uncapped OpenAI spend. Processed sequentially so we stop at the cap.
    let queued = 0
    if (autoResearch) {
      for (const lead of created) {
        try {
          await checkAndIncrementAiUsage(workspace.id, 'AI_RESEARCH')
        } catch {
          // Monthly AI limit reached — stop auto-researching further leads.
          // The leads themselves are already saved.
          break
        }
        try {
          await enqueueResearchLead({ leadId: lead.id, workspaceId: workspace.id })
          queued++
        } catch {
          // Queue failures are non-fatal — leads are already saved.
        }
      }
    }

    res.status(201).json({
      created: created.length,
      skipped: leads.length - created.length,
      queued
    })
  })
)

// ---------------------------------------------------------------------------
// Workspace API key management (requires user JWT — not ingest key)
// ---------------------------------------------------------------------------
const keyRouter = Router()
keyRouter.use(requireAuth)

// POST /api/ingest/keys/rotate?workspaceId=xxx  — generate or rotate key
keyRouter.post(
  '/rotate',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const workspaceId = String(req.query.workspaceId || '').trim()
    if (!workspaceId) throw new ApiError(400, 'workspaceId required')

    const member = await prisma.membership.findFirst({ where: { userId: user.id, workspaceId }, select: { role: true } })
    if (!member || member.role !== 'owner') throw new ApiError(403, 'Only workspace owners can manage API keys')

    // Evict old hash from cache before rotation so the stale key can't be replayed.
    const existing = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { ingestApiKey: true } })
    if (existing?.ingestApiKey) evictCachedWorkspace(existing.ingestApiKey)

    const rawKey = generateApiKey()
    await prisma.workspace.update({ where: { id: workspaceId }, data: { ingestApiKey: hashApiKey(rawKey) } })

    res.json({ ingestApiKey: rawKey })
  })
)

// DELETE /api/ingest/keys?workspaceId=xxx  — revoke key
keyRouter.delete(
  '/',
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const workspaceId = String(req.query.workspaceId || '').trim()
    if (!workspaceId) throw new ApiError(400, 'workspaceId required')

    const member = await prisma.membership.findFirst({ where: { userId: user.id, workspaceId }, select: { role: true } })
    if (!member || member.role !== 'owner') throw new ApiError(403, 'Only workspace owners can manage API keys')

    // Evict the old hash from cache before deletion so a revoked key cannot keep
    // authenticating until its TTL expires on a warm API process.
    const existing = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { ingestApiKey: true } })
    if (existing?.ingestApiKey) evictCachedWorkspace(existing.ingestApiKey)

    await prisma.workspace.update({ where: { id: workspaceId }, data: { ingestApiKey: null } })
    res.json({ ok: true })
  })
)

ingestRouter.use('/keys', keyRouter)
