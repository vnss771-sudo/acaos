import { Router } from 'express'
import { asyncHandler, ApiError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { isMailConfigured, sendMail } from '../services/mail.js'
import { prospectGuidedChat } from '../services/openai.js'
import type { ProductContext } from '../services/openai.js'

export const publicRouter = Router()

// GET /api/pub/:token — public brief page data (no auth)
publicRouter.get('/:token', asyncHandler(async (req, res) => {
  const token = req.params.token as string

  const prospect = await prisma.prospect.findUnique({
    where:   { prospectPageToken: token },
    include: {
      signals:          { orderBy: { detectedAt: 'desc' }, take: 10 },
      opportunityBrief: true,
      workspace:        { include: { workspaceProduct: true } },
    },
  })

  if (!prospect) throw new ApiError(404, 'Page not found')

  // Advance DISCOVERED → VIEWED on first page load
  if (prospect.outcomeStage === 'DISCOVERED') {
    await prisma.$transaction([
      prisma.prospect.update({ where: { id: prospect.id }, data: { outcomeStage: 'VIEWED' } }),
      prisma.prospectOutcome.create({
        data: { workspaceId: prospect.workspaceId, prospectId: prospect.id, stage: 'VIEWED' },
      }),
    ])
  }

  // Track page view — upsert session record
  await prisma.prospectPageSession.upsert({
    where:  { token },
    create: { token, viewCount: 1, lastSeenAt: new Date() },
    update: { viewCount: { increment: 1 }, lastSeenAt: new Date() },
  })

  const product = prospect.workspace.workspaceProduct

  res.json({
    companyName:   prospect.companyName,
    industry:      prospect.industry,
    location:      prospect.location,
    employeeCount: prospect.employeeCount,
    contactName:   prospect.contactName,
    contactTitle:  prospect.contactTitle,
    signals: prospect.signals.map(s => ({
      type:        s.type,
      title:       s.title,
      description: s.description,
      strength:    s.strength,
      detectedAt:  s.detectedAt.toISOString(),
    })),
    brief: prospect.opportunityBrief ? {
      buyingWindowStrength: prospect.opportunityBrief.buyingWindowStrength,
      whyNow:               prospect.opportunityBrief.whyNow,
      likelyProblem:        prospect.opportunityBrief.likelyProblem,
      problemOwnerRole:     prospect.opportunityBrief.problemOwnerRole,
      offerAngle:           prospect.opportunityBrief.offerAngle,
      outreachApproach:     prospect.opportunityBrief.outreachApproach,
      confidenceScore:      prospect.opportunityBrief.confidenceScore,
      actionRecommendation: prospect.opportunityBrief.actionRecommendation,
      whatNotToSay:         prospect.opportunityBrief.whatNotToSay,
      windowExpiresInDays:  prospect.opportunityBrief.windowExpiresInDays,
    } : null,
    product: product ? {
      productName:     product.productName,
      keyPainPoints:   product.keyPainPoints,
      differentiators: product.differentiators,
      ctaType:         product.ctaType,
      calendarUrl:     product.calendarUrl,
    } : null,
    outcomeStage: prospect.outcomeStage,
  })
}))

// POST /api/pub/:token/chat — AI guide (no auth) with session persistence + rate limit
publicRouter.post('/:token/chat', asyncHandler(async (req, res) => {
  const token = req.params.token as string
  const { message } = req.body as {
    message?: string
    history?: Array<{ role: 'user' | 'assistant'; content: string }>
  }

  if (!message || typeof message !== 'string' || message.length > 2000) {
    throw new ApiError(400, 'message required (max 2000 chars)')
  }

  const prospect = await prisma.prospect.findUnique({
    where:   { prospectPageToken: token },
    include: {
      opportunityBrief: true,
      workspace:        { include: { workspaceProduct: true } },
    },
  })

  if (!prospect) throw new ApiError(404, 'Page not found')

  // Load or create session for this page token
  const session = await prisma.prospectPageSession.upsert({
    where:  { token },
    create: { token, chatHistory: [], viewCount: 0, lastSeenAt: new Date() },
    update: { lastSeenAt: new Date() },
  })

  const chatHistory = (session.chatHistory as Array<{ role: string; content: string }>) ?? []

  // Rate limit: 40 messages per session
  if (chatHistory.length >= 40) {
    return res.status(429).json({ error: 'Chat limit reached for this page' })
  }

  const safeHistory = chatHistory
    .slice(-10)
    .filter(m => m.role && m.content && typeof m.content === 'string') as Array<{ role: 'user' | 'assistant'; content: string }>

  const reply = await prospectGuidedChat(
    {
      companyName: prospect.companyName,
      industry:    prospect.industry,
      brief: prospect.opportunityBrief ? {
        whyNow:           prospect.opportunityBrief.whyNow,
        likelyProblem:    prospect.opportunityBrief.likelyProblem,
        problemOwnerRole: prospect.opportunityBrief.problemOwnerRole,
        offerAngle:       prospect.opportunityBrief.offerAngle,
      } : null,
      product: prospect.workspace.workspaceProduct as ProductContext | null,
    },
    [...safeHistory, { role: 'user', content: message }]
  )

  // Persist updated chat history
  const updatedHistory = [
    ...chatHistory,
    { role: 'user', content: message },
    { role: 'assistant', content: reply },
  ]
  await prisma.prospectPageSession.update({
    where: { token },
    data:  { chatHistory: updatedHistory },
  })

  res.json({ reply })
}))

// POST /api/pub/:token/unsubscribe — add email to suppression list (no auth)
publicRouter.post('/:token/unsubscribe', asyncHandler(async (req, res) => {
  const token = req.params.token as string
  const prospect = await prisma.prospect.findUnique({ where: { prospectPageToken: token } })
  if (!prospect) throw new ApiError(404, 'Page not found')
  if (!prospect.contactEmail) return res.json({ ok: true })

  await prisma.emailSuppression.upsert({
    where:  { workspaceId_email: { workspaceId: prospect.workspaceId, email: prospect.contactEmail } },
    create: { workspaceId: prospect.workspaceId, email: prospect.contactEmail, reason: 'UNSUBSCRIBE' },
    update: { reason: 'UNSUBSCRIBE', suppressedAt: new Date() },
  })
  res.json({ ok: true, unsubscribed: true })
}))

// POST /api/pub/:token/cta — CTA click → advance stage + owner alert (no auth)
publicRouter.post('/:token/cta', asyncHandler(async (req, res) => {
  const token   = req.params.token as string
  const ctaType = (req.body as { ctaType?: string }).ctaType

  const prospect = await prisma.prospect.findUnique({
    where: { prospectPageToken: token },
  })

  if (!prospect) throw new ApiError(404, 'Page not found')

  if (!['MEETING', 'PROPOSAL', 'WON', 'LOST'].includes(prospect.outcomeStage)) {
    await prisma.$transaction([
      prisma.prospect.update({
        where: { id: prospect.id },
        data:  { outcomeStage: 'CONTACTED', lastContactedAt: new Date() },
      }),
      prisma.prospectOutcome.create({
        data: {
          workspaceId: prospect.workspaceId,
          prospectId:  prospect.id,
          stage:       'CONTACTED',
          notes:       `CTA clicked via personalised brief page: ${ctaType ?? 'unknown'}`,
        },
      }),
    ])
  }

  // Notify workspace owners — fire-and-forget
  if (isMailConfigured()) {
    prisma.membership.findMany({
      where:   { workspaceId: prospect.workspaceId, role: 'owner' },
      include: { user: { select: { email: true } } },
    }).then(members => {
      const ctaLabel = ctaType === 'book_call' ? 'Book a Call'
        : ctaType === 'free_trial' ? 'Start Free Trial'
        : 'a CTA button'
      const html = `
        <h2 style="color:#22c55e;font-family:sans-serif">🎯 Prospect Engaged</h2>
        <p style="font-family:sans-serif"><strong>${prospect.companyName}</strong> clicked <strong>${ctaLabel}</strong> on their personalised brief page.</p>
        ${prospect.contactName ? `<p style="font-family:sans-serif">Contact: ${prospect.contactName}${prospect.contactTitle ? ` — ${prospect.contactTitle}` : ''}</p>` : ''}
        ${prospect.contactEmail ? `<p style="font-family:sans-serif">Email: <a href="mailto:${prospect.contactEmail}">${prospect.contactEmail}</a></p>` : ''}
        <p style="font-family:sans-serif;color:#94a3b8">Stage advanced to CONTACTED.</p>
      `
      for (const m of members) {
        sendMail(m.user.email, `🎯 ${prospect.companyName} clicked ${ctaLabel}`, html).catch(() => {})
      }
    }).catch(() => {})
  }

  res.json({ ok: true })
}))
