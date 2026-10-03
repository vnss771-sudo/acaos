// Database-backed tests for mailbox sign-in routes (routes/mailboxOAuth.ts):
// start, the unauthenticated callback (signed state), disconnect, and manual
// config replacing a sign-in. Provider HTTP is faked.

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { Router } from 'express'
import { mailboxOAuthRouter, createMailOAuthCallbackHandler, createMailOAuthDisconnectHandler } from '../apps/api/src/routes/mailboxOAuth.ts'
import { requireAuth, requireVerifiedForMutation } from '../apps/api/src/middleware/auth.ts'
import { signMailOAuthState, clearMailAccessTokenCache, type FetchLike } from '../packages/backend-core/src/lib/mailOAuth.ts'
import { decryptSecret } from '../packages/backend-core/src/lib/encrypt.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace, seedUser, startTestServer, bearer, type TestServer } from './helpers/db.ts'

process.env.API_URL = 'https://api.acaos.test'
process.env.APP_URL = 'https://app.acaos.test'
process.env.GOOGLE_OAUTH_CLIENT_ID = 'gid'
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'gsecret'

const jwt = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`
let providerCalls: string[] = []
let tokenResponse: { status: number; json: unknown } = { status: 200, json: {} }
const fakeFetch: FetchLike = async (url) => {
  providerCalls.push(url)
  return new Response(JSON.stringify(tokenResponse.json), { status: tokenResponse.status, headers: { 'Content-Type': 'application/json' } })
}

let server: TestServer
before(async () => {
  const r = Router()
  // The real router serves /start; callback/disconnect get the fake provider.
  r.use('/real', mailboxOAuthRouter)
  r.get('/callback', createMailOAuthCallbackHandler({ fetch: fakeFetch }))
  r.post('/disconnect', requireAuth, requireVerifiedForMutation, createMailOAuthDisconnectHandler({ fetch: fakeFetch }))
  server = await startTestServer('/api/mailbox/oauth', r)
})
after(async () => { await server.close(); await disconnect() })
beforeEach(async () => {
  await resetDb()
  clearMailAccessTokenCache()
  providerCalls = []
  tokenResponse = { status: 200, json: { access_token: 'at', refresh_token: 'rt-secret', expires_in: 3600, id_token: jwt({ email: 'jo@gmail.com' }) } }
})

const callback = (state: string, extra = '') =>
  server.request(`/api/mailbox/oauth/callback?code=c1&state=${encodeURIComponent(state)}${extra}`, { redirect: 'manual' })

test('start returns the provider URL for an admin', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const res = await server.request('/api/mailbox/oauth/real/start', {
    method: 'POST', headers: { Authorization: bearer(user.id), 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId: workspace.id, provider: 'google' }),
  })
  assert.equal(res.status, 200)
  const url = new URL((res.body as { url: string }).url)
  assert.equal(url.hostname, 'accounts.google.com')
  assert.ok(url.searchParams.get('state'))
})

test('start is refused for an unconfigured provider', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const res = await server.request('/api/mailbox/oauth/real/start', {
    method: 'POST', headers: { Authorization: bearer(user.id), 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId: workspace.id, provider: 'microsoft' }),
  })
  assert.equal(res.status, 503)
})

test('callback connects the mailbox: provider servers, encrypted token, cursor reset, warmup started', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  await prisma.workspaceEmailConfig.create({ data: { workspaceId: workspace.id, imapHost: 'imap.old.test', imapUser: 'old@old.test', imapPass: 'x', lastSyncedUid: 500, lastUidValidity: 7 } })

  const res = await callback(signMailOAuthState({ userId: user.id, workspaceId: workspace.id, provider: 'google' }))
  assert.equal(res.status, 303)
  assert.equal(res.headers.get('location'), 'https://app.acaos.test/settings?mailbox=connected')

  const cfg = await prisma.workspaceEmailConfig.findUniqueOrThrow({ where: { workspaceId: workspace.id } })
  assert.equal(cfg.authMethod, 'GOOGLE_OAUTH')
  assert.equal(cfg.oauthAccountEmail, 'jo@gmail.com')
  assert.equal(cfg.smtpHost, 'smtp.gmail.com')
  assert.equal(cfg.imapHost, 'imap.gmail.com')
  assert.equal(cfg.imapUser, 'jo@gmail.com')
  assert.equal(cfg.smtpFrom, 'jo@gmail.com')
  assert.equal(cfg.imapPass, null)
  assert.notEqual(cfg.oauthRefreshToken, 'rt-secret')
  assert.equal(decryptSecret(cfg.oauthRefreshToken!), 'rt-secret')
  assert.equal(cfg.lastSyncedUid, 0, 'a different mailbox restarts the cursor')
  assert.equal(cfg.lastUidValidity, null)
  assert.ok((await prisma.workspaceICP.findUnique({ where: { workspaceId: workspace.id } }))?.warmupStartedAt)
  assert.ok(await prisma.auditEvent.findFirst({ where: { type: 'workspace.email_config.oauth_connect' } }))
})

test('callback rejects a tampered state, a non-admin, a cancelled sign-in and a failed exchange', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const good = signMailOAuthState({ userId: user.id, workspaceId: workspace.id, provider: 'google' })
  assert.match((await callback(`${good}x`)).headers.get('location')!, /reason=expired$/)

  const member = await seedUser('member@x.test')
  await prisma.membership.create({ data: { userId: member.id, workspaceId: workspace.id, role: 'member' } })
  const memberState = signMailOAuthState({ userId: member.id, workspaceId: workspace.id, provider: 'google' })
  assert.match((await callback(memberState)).headers.get('location')!, /reason=forbidden$/)

  const cancelled = await server.request(`/api/mailbox/oauth/callback?error=access_denied&state=${encodeURIComponent(good)}`, { redirect: 'manual' })
  assert.match(cancelled.headers.get('location')!, /reason=cancelled$/)

  tokenResponse = { status: 400, json: { error: 'invalid_grant' } }
  assert.match((await callback(good)).headers.get('location')!, /reason=exchange_failed$/)

  assert.equal(await prisma.workspaceEmailConfig.count({ where: { workspaceId: workspace.id } }), 0, 'nothing saved on any failure')
})

test('disconnect revokes at Google and clears the mailbox', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  await callback(signMailOAuthState({ userId: user.id, workspaceId: workspace.id, provider: 'google' }))
  providerCalls = []

  const res = await server.request('/api/mailbox/oauth/disconnect', {
    method: 'POST', headers: { Authorization: bearer(user.id), 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId: workspace.id }),
  })
  assert.equal(res.status, 200)
  assert.deepEqual(providerCalls, ['https://oauth2.googleapis.com/revoke'])
  const cfg = await prisma.workspaceEmailConfig.findUniqueOrThrow({ where: { workspaceId: workspace.id } })
  assert.equal(cfg.authMethod, 'PASSWORD')
  assert.equal(cfg.oauthRefreshToken, null)
  assert.equal(cfg.smtpHost, null)
  assert.equal(cfg.imapHost, null)
})

test('disconnect with no signed-in mailbox is a 409', async () => {
  const { user, workspace } = await seedUserWithWorkspace()
  const res = await server.request('/api/mailbox/oauth/disconnect', {
    method: 'POST', headers: { Authorization: bearer(user.id), 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId: workspace.id }),
  })
  assert.equal(res.status, 409)
})
