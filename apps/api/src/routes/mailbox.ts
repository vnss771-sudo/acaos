import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireVerifiedEmail, requireVerifiedForMutation } from '../middleware/auth.js'
import { requireFeature } from '../middleware/featureGate.js'
import { prisma } from '@acaos/backend-core/lib/prisma.js'
import { asyncHandler, ApiError, requireUser } from '../lib/http.js'
import { parseBody, parseQuery, workspaceIdField } from '../lib/validate.js'
import { mailRateLimit, syncRateLimit } from '../middleware/rateLimit.js'
import { enforceWorkspaceMailRate } from '../lib/workspaceRateLimit.js'
import { isMailConfigured, isMailboxConfigured, sendMail, syncMailboxOnce } from '../services/mail.js'
import { isValidEmail } from '../lib/textNormalize.js'
import { assertWorkspacePermission } from '../lib/permissions.js'
import { userHasWorkspaceAccess } from '../lib/workspaces.js'
import {
  checkDomainHealth, dkimQueryName, isDkimRecord, sendingDomainOf, type DomainHealthReport,
} from '@acaos/backend-core/lib/domainHealth.js'

export const mailboxRouter = Router()
mailboxRouter.use(requireAuth)
mailboxRouter.use(requireVerifiedForMutation)

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

// Validate the domain shape before any DNS lookup (rejects localhost, bare IPs,
// and junk — resolveTxt makes no outbound connection, but this keeps inputs sane).
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i
const checkDomainSchema = z.object({
  domain: z.string().trim().regex(DOMAIN_RE, 'valid domain required'),
  // Optional DKIM selector; if omitted we probe COMMON_DKIM_SELECTORS.
  selector: z.string().trim().regex(/^[A-Za-z0-9._-]{1,63}$/, 'invalid selector').optional(),
})

// Re-exported for existing callers/tests; the checks live in backend-core.
export { dkimQueryName, isDkimRecord }

const domainHealthSchema = z.object({ workspaceId: workspaceIdField })

mailboxRouter.post(
  '/send-test',
  requireVerifiedEmail,
  mailRateLimit,
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
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
    // Per-workspace tier on top of mailRateLimit's per-IP window (see S1) — a
    // workspace spraying sends across rotating IPs is still capped.
    await enforceWorkspaceMailRate(workspaceId)

    const result = await sendMail(to, subject || 'Test', html || '<p>Hello</p>', emailCfg)
    res.json({ id: result.messageId })
  })
)

mailboxRouter.post(
  '/sync',
  requireVerifiedEmail,
  requireFeature('mailboxSync'),
  syncRateLimit,
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
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

// Check a domain's SPF/DKIM/DMARC records and blocklist status on demand. The
// hasSPF/hasDKIM/dkimSelector/checkedSelectors/spfRecords fields predate the full
// report and are kept for existing clients.
mailboxRouter.get(
  '/check-domain',
  asyncHandler(async (req, res) => {
    const { domain, selector } = parseQuery(checkDomainSchema, req)
    const report = await checkDomainHealth(domain, { dkimSelectors: selector ? [selector] : undefined })
    res.json({
      ...report,
      hasSPF: report.spf.records.length > 0,
      hasDKIM: report.dkim.status === 'ok',
      dkimSelector: report.dkim.selector,
      checkedSelectors: report.dkim.checkedSelectors,
      spfRecords: report.spf.records,
    })
  })
)

// The latest report stored by the worker's scheduled domain-health sweep for the
// workspace's sending domain. `report` is null until the first sweep has run.
mailboxRouter.get(
  '/domain-health',
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { workspaceId } = parseQuery(domainHealthSchema, req)
    if (!await userHasWorkspaceAccess(user.id, workspaceId)) throw new ApiError(403, 'Access denied')

    const cfg = await prisma.workspaceEmailConfig.findUnique({
      where: { workspaceId },
      select: { smtpFrom: true, domainHealth: true, domainHealthCheckedAt: true },
    })
    const domain = sendingDomainOf(cfg?.smtpFrom)
    const stored = cfg?.domainHealth as DomainHealthReport | null | undefined
    res.json({
      domain,
      // A report for a previous From domain is stale once the address changes.
      report: stored && stored.domain === domain ? stored : null,
      checkedAt: stored && stored.domain === domain ? cfg?.domainHealthCheckedAt ?? null : null,
    })
  })
)
