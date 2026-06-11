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
trackingRouter.get('/open/:id', asyncHandler(async (req, res) => {
  const id = req.params.id
  // Fire-and-forget — we never block the email client
  prisma.messageOutcome.updateMany({
    where: { id, event: 'SENT' },
    data:  { event: 'OPENED', respondedAt: new Date() },
  }).catch(() => {})

  res.setHeader('Content-Type', 'image/gif')
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
  res.setHeader('Pragma', 'no-cache')
  res.end(PIXEL_GIF)
}))

// GET /api/track/click/:id?url=... — click tracking + redirect
trackingRouter.get('/click/:id', asyncHandler(async (req, res) => {
  const id      = req.params.id
  const target  = req.query.url as string | undefined

  if (!target || !/^https?:\/\//.test(target)) {
    res.status(400).send('Missing or invalid url parameter')
    return
  }

  prisma.messageOutcome.updateMany({
    where: { id, event: { in: ['SENT', 'OPENED'] } },
    data:  { event: 'CLICKED', respondedAt: new Date() },
  }).catch(() => {})

  res.redirect(302, target)
}))
