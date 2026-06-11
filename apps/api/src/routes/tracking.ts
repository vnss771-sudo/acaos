import { Router } from 'express'
import { asyncHandler } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'

export const trackingRouter = Router()

// 1×1 transparent GIF
const PIXEL_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
)

// GET /api/track/open/:id — email open tracking
// Append-only: creates a new OPENED row rather than mutating the SENT row,
// so the SENT denominator is preserved for learning-loop calibration.
trackingRouter.get('/open/:id', asyncHandler(async (req, res) => {
  const id  = req.params.id as string
  const now = new Date()

  // Fire-and-forget — never block the email client
  prisma.messageOutcome.findUnique({
    where:  { id },
    select: { workspaceId: true, prospectId: true, channel: true },
  }).then(original => {
    if (!original) return
    return prisma.messageOutcome.create({
      data: {
        workspaceId: original.workspaceId,
        prospectId:  original.prospectId,
        event:       'OPENED',
        channel:     original.channel,
        sentAt:      now,
        respondedAt: now,
      },
    })
  }).catch(() => {})

  res.setHeader('Content-Type', 'image/gif')
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
  res.setHeader('Pragma', 'no-cache')
  res.end(PIXEL_GIF)
}))

// GET /api/track/click/:id?url=... — click tracking + redirect
// Same append-only pattern: creates a new CLICKED row.
trackingRouter.get('/click/:id', asyncHandler(async (req, res) => {
  const id     = req.params.id as string
  const target = req.query.url as string | undefined

  if (!target || !/^https?:\/\//.test(target)) {
    res.status(400).send('Missing or invalid url parameter')
    return
  }

  const now = new Date()
  prisma.messageOutcome.findUnique({
    where:  { id },
    select: { workspaceId: true, prospectId: true, channel: true },
  }).then(original => {
    if (!original) return
    return prisma.messageOutcome.create({
      data: {
        workspaceId: original.workspaceId,
        prospectId:  original.prospectId,
        event:       'CLICKED',
        channel:     original.channel,
        sentAt:      now,
        respondedAt: now,
      },
    })
  }).catch(() => {})

  res.redirect(302, target)
}))
