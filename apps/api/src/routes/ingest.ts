import { Router } from 'express'
import { randomBytes } from 'node:crypto'
import { asyncHandler, ApiError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { enqueueResearchLead } from '../lib/queues.js'
import { requireAuth } from '../middleware/auth.js'
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
  const workspace = await prisma.workspace.findUnique({ where: { ingestApiKey: key } })
  if (!workspace) {
    res.status(401).json({ error: 'Invalid API key' })
    return
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
    const existingEmails = new Set(existing.map((l) => l.email!.toLowerCase()))

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

    // Insert new leads one-by-one so we get their IDs for queue jobs
    const created = await prisma.$transaction(rows.map((data) => prisma.lead.create({ data })))

    // Enqueue AI research for each new lead if requested
    let queued = 0
    if (autoResearch) {
      await Promise.all(
        created.map(async (lead) => {
          try {
            await enqueueResearchLead(lead.id, workspace.id)
            queued++
          } catch {
            // Queue failures are non-fatal — leads are already saved
          }
        })
      )
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

    const ingestApiKey = randomBytes(32).toString('hex')
    await prisma.workspace.update({ where: { id: workspaceId }, data: { ingestApiKey } })

    res.json({ ingestApiKey })
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

    await prisma.workspace.update({ where: { id: workspaceId }, data: { ingestApiKey: null } })
    res.json({ ok: true })
  })
)

ingestRouter.use('/keys', keyRouter)
