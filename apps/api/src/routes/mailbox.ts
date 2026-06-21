import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireVerifiedEmail, requireVerifiedForMutation } from '../middleware/auth.js'
import { requireFeature } from '../middleware/featureGate.js'
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
  // Optional DKIM selector; if omitted we probe the common defaults below.
  selector: z.string().trim().regex(/^[A-Za-z0-9._-]{1,63}$/, 'invalid selector').optional(),
})

// DKIM keys live at <selector>._domainkey.<domain>, not the root domain. Without a
// caller-supplied selector we probe the selectors the major providers use.
const COMMON_DKIM_SELECTORS = ['google', 'default', 'selector1', 'selector2', 'k1', 'dkim', 'mail', 's1']

/** The DNS name a DKIM TXT record for `selector` lives at. */
export function dkimQueryName(selector: string, domain: string): string {
  return `${selector}._domainkey.${domain}`
}

/** True if the (possibly multi-chunk) TXT record is a DKIM key. */
export function isDkimRecord(txtChunks: string[]): boolean {
  return /v=DKIM1/i.test(txtChunks.join(''))
}

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
  requireFeature('mailboxSync'),
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
    const { domain, selector } = parseQuery(checkDomainSchema, req)

    // SPF lives at the root domain TXT.
    let rootTxt: string[] = []
    try {
      rootTxt = (await dns.resolveTxt(domain)).flat()
    } catch {
      // NXDOMAIN or SERVFAIL — domain has no TXT records
    }
    const spfRecords = rootTxt.filter(r => r.startsWith('v=spf1'))
    const hasSPF = spfRecords.length > 0

    // DKIM is NOT at the root — it lives at <selector>._domainkey.<domain>. Probe
    // the caller's selector if given, else the common provider defaults, in
    // parallel so latency is bounded by a single DNS timeout.
    const selectors = selector ? [selector] : COMMON_DKIM_SELECTORS
    const probes = await Promise.allSettled(
      selectors.map(async sel => {
        const chunks = (await dns.resolveTxt(dkimQueryName(sel, domain))).map(c => c.join(''))
        return { sel, ok: isDkimRecord(chunks) }
      })
    )
    const matched = probes.find((p): p is PromiseFulfilledResult<{ sel: string; ok: boolean }> => p.status === 'fulfilled' && p.value.ok)
    const dkimSelector = matched ? matched.value.sel : null

    res.json({
      domain,
      hasSPF,
      hasDKIM: dkimSelector !== null,
      dkimSelector,
      checkedSelectors: selectors,
      spfRecords,
    })
  })
)
