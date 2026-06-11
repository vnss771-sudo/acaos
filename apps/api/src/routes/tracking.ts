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
// id may be a MessageOutcome id OR a MessageSend id — we try both.
trackingRouter.get('/open/:id', asyncHandler(async (req, res) => {
  const id  = req.params.id as string
  const now = new Date()

  // Fire-and-forget — never block the email client
  Promise.allSettled([
    // Legacy path: MessageOutcome
    prisma.messageOutcome.findUnique({
      where:  { id },
      select: { workspaceId: true, prospectId: true, channel: true },
    }).then(original => {
      if (!original) return
      return prisma.messageOutcome.create({
        data: {
          workspaceId: original.workspaceId,
          prospectId:  original.prospectId ?? undefined,
          event:       'OPENED',
          channel:     original.channel,
          sentAt:      now,
          respondedAt: now,
        },
      })
    }),
    // New path: EngagementEvent against MessageSend
    prisma.messageSend.findUnique({
      where:  { id },
      select: { workspaceId: true, prospectId: true },
    }).then(send => {
      if (!send) return
      return prisma.engagementEvent.create({
        data: {
          workspaceId: send.workspaceId,
          prospectId:  send.prospectId,
          sendId:      id,
          eventType:   'OPENED',
          occurredAt:  now,
        },
      })
    }),
  ]).catch(() => {})

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
  Promise.allSettled([
    prisma.messageOutcome.findUnique({
      where:  { id },
      select: { workspaceId: true, prospectId: true, channel: true },
    }).then(original => {
      if (!original) return
      return prisma.messageOutcome.create({
        data: {
          workspaceId: original.workspaceId,
          prospectId:  original.prospectId ?? undefined,
          event:       'CLICKED',
          channel:     original.channel,
          sentAt:      now,
          respondedAt: now,
        },
      })
    }),
    prisma.messageSend.findUnique({
      where:  { id },
      select: { workspaceId: true, prospectId: true },
    }).then(send => {
      if (!send) return
      return prisma.engagementEvent.create({
        data: {
          workspaceId: send.workspaceId,
          prospectId:  send.prospectId,
          sendId:      id,
          eventType:   'CLICKED',
          occurredAt:  now,
        },
      })
    }),
  ]).catch(() => {})

  res.redirect(302, target)
}))
