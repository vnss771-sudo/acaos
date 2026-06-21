import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireVerifiedEmail } from '../middleware/auth.js'
import { prisma } from '../lib/prisma.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { parseBody, parseQuery, workspaceIdField } from '../lib/validate.js'
import { mailRateLimit, syncRateLimit } from '../middleware/rateLimit.js'
import { isMailConfigured, isMailboxConfigured, sendMail, syncMailboxOnce } from '../services/mail.js'
import { isValidEmail } from '../lib/validation.js'
import { assertWorkspacePermission } from '../lib/permissions.js'
import { promises as dns } from 'dns'

export const mailboxRouter = Router()
mailboxRouter.use(requireAuth)

// `to` stays optional here on purpose: recipient validity is checked in-handler
// *after* the SMTP-configured guard, so an unconfigured workspace returns 503
// rather than leaking that the recipient was the problem.
const sendTestSchema = z.object({
  workspaceId: workspaceIdField,
  to: z.string().optional(),
  subject: z.string().optional(),
  html: z.string().optional(),
})
const syncSchema = z.object({ workspaceId: workspaceIdField })
const checkDomainSchema = z.object({ domain: z.string().trim().min(1, 'domain required') })

mailboxRouter.post(
  '/send-test',
  requireVerifiedEmail,
  mailRateLimit,
  asyncHandler(async (req, res) => {
    const user = req.user!
    const parsed = parseBody(sendTestSchema, req)
    const workspaceId = parsed.workspaceId
    const to = (parsed.to ?? '').trim()
    const subject = typeof parsed.subject === 'string' ? parsed.subject.trim() : 'Test'
    const html = typeof parsed.html === 'string' ? parsed.html : '<p>Hello</p>'

    const emailCfg = await prisma.workspaceEmailConfig.findUnique({ where: { workspaceId } })
    if (!isMailConfigured(emailCfg)) throw new ApiError(503, 'SMTP is not configured')

    if (!to || !isValidEmail(to)) throw new ApiError(400, 'Valid recipient email required')

    // Require owner or admin — test-send uses real SMTP credits
    await assertWorkspacePermission(user.id, workspaceId, 'mail:send_test')

    const result = await sendMail(to, subject || 'Test', html || '<p>Hello</p>', emailCfg)
    res.json({ id: result.messageId })
  })
)

mailboxRouter.post(
  '/sync',
  requireVerifiedEmail,
  syncRateLimit,
  asyncHandler(async (req, res) => {
    const user = req.user!
    const { workspaceId } = parseBody(syncSchema, req)

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

// Check domain DNS records for SPF/DKIM deliverability prerequisites
mailboxRouter.get(
  '/check-domain',
  asyncHandler(async (req, res) => {
    const { domain } = parseQuery(checkDomainSchema, req)

    let records: string[] = []
    try {
      const txtRecords = await dns.resolveTxt(domain)
      records = txtRecords.flat()
    } catch {
      // NXDOMAIN or SERVFAIL — domain has no TXT records
    }

    const hasSPF = records.some(r => r.startsWith('v=spf1'))
    const hasDKIM = records.some(r => r.startsWith('v=DKIM1'))

    res.json({
      domain,
      hasSPF,
      hasDKIM,
      spfRecords: records.filter(r => r.startsWith('v=spf1')),
    })
  })
)
