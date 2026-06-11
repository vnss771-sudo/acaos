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

// POST /api/pub/:token/chat — AI guide (no auth)
publicRouter.post('/:token/chat', asyncHandler(async (req, res) => {
  const token = req.params.token as string
  const { message, history } = req.body as {
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

  const safeHistory = Array.isArray(history)
    ? history.slice(-10).filter(m => m.role && m.content && typeof m.content === 'string')
    : []

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

  res.json({ reply })
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
