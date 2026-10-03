import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, requireVerifiedForMutation } from '../middleware/auth.js'
import { prisma } from '@acaos/backend-core/lib/prisma.js'
import { encryptSecret } from '@acaos/backend-core/lib/encrypt.js'
import { recordAudit } from '@acaos/backend-core/lib/audit.js'
import {
  AUTH_METHOD, AUTH_METHOD_PASSWORD, MAIL_OAUTH_PROVIDERS, buildMailOAuthUrl, configuredMailOAuthProviders,
  exchangeMailOAuthCode, mailOAuthServers, primeMailAccessToken, providerForAuthMethod, revokeMailOAuth,
  signMailboxConnectState, verifyMailboxConnectState, type FetchLike, type MailboxConnectState,
} from '@acaos/backend-core/lib/mailOAuth.js'
import { asyncHandler, ApiError, requireUser } from '../lib/http.js'
import { parseBody, workspaceIdField } from '../lib/validate.js'
import { assertWorkspacePermission } from '../lib/permissions.js'
import { startSenderWarmupOnce } from './workspaces/emailConfig.js'

// Sign in with Google / Microsoft for the workspace mailbox (lib/mailOAuth.ts).
// Mounted at /api/mailbox/oauth BEFORE the mailbox router: the callback is a
// browser redirect from the provider and carries no bearer token (the signed
// state identifies the user), so it must not hit mailboxRouter's requireAuth.
export const mailboxOAuthRouter = Router()

const startSchema = z.object({
  workspaceId: workspaceIdField,
  provider: z.enum(MAIL_OAUTH_PROVIDERS),
})
const disconnectSchema = z.object({ workspaceId: workspaceIdField })

// POST /api/mailbox/oauth/start → { url } to send the browser to.
mailboxOAuthRouter.post(
  '/start',
  requireAuth,
  requireVerifiedForMutation,
  asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { workspaceId, provider } = parseBody(startSchema, req)
    await assertWorkspacePermission(user.id, workspaceId, 'email_config:manage')
    if (!configuredMailOAuthProviders().includes(provider)) throw new ApiError(503, 'This sign-in option is not configured')
    res.json({ url: buildMailOAuthUrl(provider, signMailboxConnectState({ userId: user.id, workspaceId, provider })) })
  })
)

// Short, fixed reason codes only; never provider error text in a URL.
type CallbackReason = 'cancelled' | 'provider_error' | 'expired' | 'forbidden' | 'exchange_failed'

export function createMailOAuthCallbackHandler(deps: { fetch?: FetchLike } = {}) {
  return asyncHandler(async (req, res) => {
    const appUrl = (process.env.APP_URL || 'http://localhost:5173').replace(/\/+$/, '')
    const back = (reason?: CallbackReason) =>
      res.redirect(303, `${appUrl}/settings?mailbox=${reason ? `error&reason=${reason}` : 'connected'}`)

    const q = req.query as Record<string, unknown>
    if (typeof q.error === 'string') return back(q.error === 'access_denied' ? 'cancelled' : 'provider_error')

    let state: MailboxConnectState
    try { state = verifyMailboxConnectState(String(q.state ?? '')) } catch { return back('expired') }
    const code = typeof q.code === 'string' ? q.code : ''
    if (!code) return back('provider_error')

    // The state proves who started the flow; their permission is re-checked now
    // (a role could have changed in the minutes since).
    try { await assertWorkspacePermission(state.userId, state.workspaceId, 'email_config:manage') } catch { return back('forbidden') }

    let grant
    try {
      grant = await exchangeMailOAuthCode(state.provider, code, deps.fetch)
    } catch (err) {
      console.error(`[mailbox-oauth] ${state.provider} code exchange failed for workspace ${state.workspaceId}: ${err instanceof Error ? err.message : err}`)
      return back('exchange_failed')
    }

    const { workspaceId, provider } = state
    const existing = await prisma.workspaceEmailConfig.findUnique({
      where: { workspaceId },
      select: { imapHost: true, imapUser: true, smtpFrom: true },
    })
    const servers = mailOAuthServers(provider)
    // A different mailbox means the stored UID cursor belongs to someone else's
    // INBOX: start over rather than skip (or re-read) the wrong UIDs.
    const mailboxChanged = !existing || existing.imapHost !== servers.imapHost || existing.imapUser?.toLowerCase() !== grant.accountEmail
    // Keep a display-name From ("Jo's Plumbing <jo@x.com>") if it's for this address.
    const smtpFrom = existing?.smtpFrom && existing.smtpFrom.toLowerCase().includes(grant.accountEmail) ? existing.smtpFrom : grant.accountEmail
    const refreshBlob = encryptSecret(grant.refreshToken)
    const data = {
      ...servers,
      smtpUser: grant.accountEmail,
      smtpFrom,
      imapUser: grant.accountEmail,
      smtpPass: null,
      imapPass: null,
      authMethod: AUTH_METHOD[provider],
      oauthAccountEmail: grant.accountEmail,
      oauthRefreshToken: refreshBlob,
      oauthConnectedAt: new Date(),
      oauthError: null,
      ...(mailboxChanged ? { lastSyncedUid: 0, lastUidValidity: null } : {}),
    }
    await prisma.workspaceEmailConfig.upsert({ where: { workspaceId }, create: { workspaceId, ...data }, update: data })
    primeMailAccessToken(workspaceId, refreshBlob, grant.accessToken, grant.expiresAt)
    await startSenderWarmupOnce(workspaceId)

    void recordAudit({
      workspaceId, actorUserId: state.userId, type: 'workspace.email_config.oauth_connect',
      entityType: 'workspaceEmailConfig', entityId: workspaceId,
      metadata: { provider, account: grant.accountEmail, mailboxChanged },
    })
    return back()
  })
}

mailboxOAuthRouter.get('/callback', createMailOAuthCallbackHandler())

// POST /api/mailbox/oauth/disconnect — remove the signed-in mailbox.
export function createMailOAuthDisconnectHandler(deps: { fetch?: FetchLike } = {}) {
  return asyncHandler(async (req, res) => {
    const user = requireUser(req)
    const { workspaceId } = parseBody(disconnectSchema, req)
    await assertWorkspacePermission(user.id, workspaceId, 'email_config:manage')

    const cfg = await prisma.workspaceEmailConfig.findUnique({
      where: { workspaceId },
      select: { workspaceId: true, authMethod: true, oauthRefreshToken: true, oauthAccountEmail: true },
    })
    const provider = providerForAuthMethod(cfg?.authMethod)
    if (!cfg || !provider) throw new ApiError(409, 'No signed-in mailbox to disconnect')

    await revokeMailOAuth(cfg, deps.fetch)
    await prisma.workspaceEmailConfig.update({
      where: { workspaceId },
      data: {
        authMethod: AUTH_METHOD_PASSWORD,
        oauthAccountEmail: null, oauthRefreshToken: null, oauthConnectedAt: null, oauthError: null,
        smtpHost: null, smtpPort: null, smtpUser: null, smtpFrom: null, smtpPass: null,
        imapHost: null, imapPort: null, imapUser: null, imapPass: null,
        lastSyncedUid: 0, lastUidValidity: null,
      },
    })
    void recordAudit({
      workspaceId, actorUserId: user.id, type: 'workspace.email_config.oauth_disconnect',
      entityType: 'workspaceEmailConfig', entityId: workspaceId,
      metadata: { provider, account: cfg.oauthAccountEmail },
    })
    res.json({ ok: true })
  })
}

mailboxOAuthRouter.post('/disconnect', requireAuth, requireVerifiedForMutation, createMailOAuthDisconnectHandler())
