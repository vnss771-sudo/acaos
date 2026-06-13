import { Router } from 'express'
import { requireAuth, requireVerifiedEmail } from '../middleware/auth.js'
import { prisma } from '../lib/prisma.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { mailRateLimit, syncRateLimit } from '../middleware/rateLimit.js'
import { isMailConfigured, isMailboxConfigured, sendMail, syncMailboxOnce } from '../services/mail.js'
import { isValidEmail } from '../lib/validation.js'
import type { AuthedRequest } from '../types/auth.js'

export const mailboxRouter = Router()
mailboxRouter.use(requireAuth)

mailboxRouter.post(
  '/send-test',
  requireVerifiedEmail,
  mailRateLimit,
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const to = String(req.body?.to || '').trim()
    const subject = typeof req.body?.subject === 'string' ? req.body.subject.trim() : 'Test'
    const html = typeof req.body?.html === 'string' ? req.body.html : '<p>Hello</p>'
    const workspaceId = String(req.body?.workspaceId || '').trim()

    const emailCfg = workspaceId
      ? await prisma.workspaceEmailConfig.findUnique({ where: { workspaceId } })
      : null

    if (!isMailConfigured(emailCfg)) {
      throw new ApiError(503, 'SMTP is not configured')
    }

    if (!to || !isValidEmail(to)) {
      throw new ApiError(400, 'Valid recipient email required')
    }

    // Require owner or admin — test-send uses real SMTP credits
    if (workspaceId) {
      const member = await prisma.membership.findFirst({
        where: { userId: user.id, workspaceId, role: { in: ['owner', 'admin'] } }
      })
      if (!member) throw new ApiError(403, 'Must be owner or admin to send test emails')
    }

    const result = await sendMail(to, subject || 'Test', html || '<p>Hello</p>', emailCfg)
    res.json({ id: result.messageId })
  })
)

mailboxRouter.post(
  '/sync',
  requireVerifiedEmail,
  syncRateLimit,
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const workspaceId = String(req.body?.workspaceId || '').trim()
    if (!workspaceId) throw new ApiError(400, 'workspaceId required')

    const member = await prisma.membership.findFirst({ where: { userId: user.id, workspaceId } })
    if (!member) throw new ApiError(403, 'Access denied')

    const emailCfg = await prisma.workspaceEmailConfig.findUnique({ where: { workspaceId } })

    if (!isMailboxConfigured(emailCfg)) {
      throw new ApiError(503, 'IMAP is not configured')
    }

    const result = await syncMailboxOnce(emailCfg, workspaceId)
    res.json(result)
  })
)
