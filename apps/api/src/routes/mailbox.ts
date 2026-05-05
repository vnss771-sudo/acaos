import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { isMailConfigured, isMailboxConfigured, sendMail, syncMailboxOnce } from '../services/mail.js'
import { isValidEmail } from '../lib/validation.js'

export const mailboxRouter = Router()
mailboxRouter.use(requireAuth)

mailboxRouter.post(
  '/send-test',
  asyncHandler(async (req, res) => {
    const to = String(req.body?.to || '').trim()
    const subject = typeof req.body?.subject === 'string' ? req.body.subject.trim() : 'Test'
    const html = typeof req.body?.html === 'string' ? req.body.html : '<p>Hello</p>'

    if (!isMailConfigured()) {
      throw new ApiError(503, 'SMTP is not configured')
    }

    if (!to || !isValidEmail(to)) {
      throw new ApiError(400, 'Valid recipient email required')
    }

    const result = await sendMail(to, subject || 'Test', html || '<p>Hello</p>')
    res.json({ id: result.messageId })
  })
)

mailboxRouter.post(
  '/sync',
  asyncHandler(async (_req, res) => {
    if (!isMailboxConfigured()) {
      throw new ApiError(503, 'IMAP is not configured')
    }

    const result = await syncMailboxOnce()
    res.json(result)
  })
)
