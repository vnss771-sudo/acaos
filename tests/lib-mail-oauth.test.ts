// Unit tests for mailbox sign-in (lib/mailOAuth.ts) and how mail.ts treats a
// signed-in config. Pure: fetch and persistence are injected.

import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildMailOAuthUrl, clearMailAccessTokenCache, configuredMailOAuthProviders, exchangeMailOAuthCode,
  getMailAccessToken, signMailboxConnectState, verifyMailboxConnectState, RECONNECT_MESSAGE, type FetchLike,
} from '../packages/backend-core/src/lib/mailOAuth.ts'
import { buildTransport, isMailConfigured, isMailboxConfigured } from '../packages/backend-core/src/services/mail.ts'

const ENV = {
  API_URL: 'https://api.acaos.test',
  GOOGLE_OAUTH_CLIENT_ID: 'gid', GOOGLE_OAUTH_CLIENT_SECRET: 'gsecret',
  MICROSOFT_OAUTH_CLIENT_ID: 'mid', MICROSOFT_OAUTH_CLIENT_SECRET: 'msecret',
}
for (const [k, v] of Object.entries(ENV)) process.env[k] = v
beforeEach(() => clearMailAccessTokenCache())

const jwt = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`
function fakeFetch(responses: Array<{ status?: number; json: unknown }>) {
  const calls: Array<{ url: string; body: string }> = []
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, body: String(init.body ?? '') })
    const r = responses.shift() ?? { status: 500, json: {} }
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } })
  }
  return { fn, calls }
}

test('providers are offered only with client credentials and API_URL', () => {
  assert.deepEqual(configuredMailOAuthProviders(), ['google', 'microsoft'])
  delete process.env.MICROSOFT_OAUTH_CLIENT_SECRET
  assert.deepEqual(configuredMailOAuthProviders(), ['google'])
  process.env.MICROSOFT_OAUTH_CLIENT_SECRET = ENV.MICROSOFT_OAUTH_CLIENT_SECRET
  delete process.env.API_URL
  assert.deepEqual(configuredMailOAuthProviders(), [])
  process.env.API_URL = ENV.API_URL
})

test('state round-trips and rejects tampering, expiry and junk', () => {
  const s = { userId: 'u1', workspaceId: 'w1', provider: 'google' as const }
  const now = 1_000_000
  const state = signMailboxConnectState(s, now)
  assert.deepEqual(verifyMailboxConnectState(state, now + 60_000), s)
  assert.throws(() => verifyMailboxConnectState(state, now + 11 * 60_000), /too long/)
  const [body, sig] = state.split('.')
  const forged = Buffer.from(JSON.stringify({ u: 'attacker', w: 'w1', p: 'google', n: 'x', exp: now + 1e6 })).toString('base64url')
  assert.throws(() => verifyMailboxConnectState(`${forged}.${sig}`, now), /Invalid/)
  assert.throws(() => verifyMailboxConnectState(`${body}.${sig}x`, now), /Invalid/)
  assert.throws(() => verifyMailboxConnectState('nonsense', now), /Invalid/)
})

test('authorization URL asks for offline IMAP/SMTP access with the registered redirect', () => {
  const g = new URL(buildMailOAuthUrl('google', 'st'))
  assert.equal(g.origin + g.pathname, 'https://accounts.google.com/o/oauth2/v2/auth')
  assert.equal(g.searchParams.get('redirect_uri'), 'https://api.acaos.test/api/mailbox/oauth/callback')
  assert.equal(g.searchParams.get('access_type'), 'offline')
  assert.equal(g.searchParams.get('prompt'), 'consent')
  assert.deepEqual(g.searchParams.get('scope')!.split(' '), ['openid', 'email', 'https://mail.google.com/'])
  assert.equal(g.searchParams.get('state'), 'st')
  const m = new URL(buildMailOAuthUrl('microsoft', 'st'))
  assert.equal(m.origin + m.pathname, 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize')
  assert.deepEqual(m.searchParams.get('scope')!.split(' '), [
    'openid', 'email', 'offline_access',
    'https://outlook.office.com/IMAP.AccessAsUser.All', 'https://outlook.office.com/SMTP.Send',
  ])
})

test('code exchange returns the mailbox address and tokens', async () => {
  const { fn, calls } = fakeFetch([{ json: { access_token: 'at', refresh_token: 'rt', expires_in: 3600, id_token: jwt({ email: 'Jo@Gmail.com' }) } }])
  const grant = await exchangeMailOAuthCode('google', 'code1', fn, 0)
  assert.deepEqual(grant, { accountEmail: 'jo@gmail.com', refreshToken: 'rt', accessToken: 'at', expiresAt: 3_600_000 })
  const form = new URLSearchParams(calls[0].body)
  assert.equal(form.get('grant_type'), 'authorization_code')
  assert.equal(form.get('client_secret'), 'gsecret')
})

test('code exchange fails closed without a refresh token or an address', async () => {
  await assert.rejects(exchangeMailOAuthCode('google', 'c', fakeFetch([{ json: { access_token: 'at', id_token: jwt({ email: 'a@b.c' }) } }]).fn), /offline access/)
  await assert.rejects(exchangeMailOAuthCode('microsoft', 'c', fakeFetch([{ json: { access_token: 'at', refresh_token: 'rt' } }]).fn), /mailbox address/)
  await assert.rejects(exchangeMailOAuthCode('google', 'c', fakeFetch([{ status: 400, json: { error: 'invalid_request' } }]).fn), /token request failed/)
})

test('access tokens are cached until near expiry, then refreshed', async () => {
  const cfg = { workspaceId: 'w1', authMethod: 'GOOGLE_OAUTH', oauthRefreshToken: 'rt-plain' }
  const { fn, calls } = fakeFetch([{ json: { access_token: 'a1', expires_in: 3600 } }, { json: { access_token: 'a2', expires_in: 3600 } }])
  let t = 0
  const deps = { fetch: fn, now: () => t, persist: async () => { throw new Error('nothing to persist') } }
  assert.equal(await getMailAccessToken(cfg, deps), 'a1')
  t = 30 * 60_000
  assert.equal(await getMailAccessToken(cfg, deps), 'a1', 'served from cache')
  t = 59 * 60_000
  assert.equal(await getMailAccessToken(cfg, deps), 'a2', 'refreshed inside the 2-minute margin')
  assert.equal(calls.length, 2)
  const refreshForm = new URLSearchParams(calls[0].body)
  assert.equal(refreshForm.get('grant_type'), 'refresh_token')
  assert.equal(refreshForm.get('refresh_token'), 'rt-plain')
})

test('a rotated refresh token is persisted encrypted', async () => {
  const persisted: unknown[] = []
  const { fn } = fakeFetch([{ json: { access_token: 'a1', refresh_token: 'rt-new', expires_in: 3600 } }])
  await getMailAccessToken({ workspaceId: 'w2', authMethod: 'MICROSOFT_OAUTH', oauthRefreshToken: 'rt-old' }, { fetch: fn, persist: async (_w, d) => { persisted.push(d) } })
  assert.equal(persisted.length, 1)
  const d = persisted[0] as { oauthRefreshToken: string; oauthError: null }
  assert.notEqual(d.oauthRefreshToken, 'rt-new', 'never stored in plaintext')
  assert.equal(d.oauthError, null)
})

test('a revoked grant records needs-reconnect and throws 409', async () => {
  const persisted: unknown[] = []
  const { fn } = fakeFetch([{ status: 400, json: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } }])
  await assert.rejects(
    getMailAccessToken({ workspaceId: 'w3', authMethod: 'GOOGLE_OAUTH', oauthRefreshToken: 'rt' }, { fetch: fn, persist: async (_w, d) => { persisted.push(d) } }),
    (err: { statusCode?: number; message?: string }) => err.statusCode === 409 && err.message === RECONNECT_MESSAGE,
  )
  assert.deepEqual(persisted, [{ oauthError: RECONNECT_MESSAGE }])
})

test('mail.ts: a signed-in config is configured without passwords; one that lost its token is not', () => {
  const signedIn = {
    workspaceId: 'w', authMethod: 'GOOGLE_OAUTH', oauthRefreshToken: 'enc',
    smtpHost: 'smtp.gmail.com', smtpFrom: 'jo@gmail.com', imapHost: 'imap.gmail.com', imapUser: 'jo@gmail.com',
  }
  assert.equal(isMailConfigured(signedIn), true)
  assert.equal(isMailboxConfigured(signedIn), true)
  const lost = { ...signedIn, oauthRefreshToken: null }
  assert.equal(isMailConfigured(lost), false, 'must not fall back to the platform relay')
  assert.equal(isMailboxConfigured(lost), false)
})

test('mail.ts: SMTP authenticates with XOAUTH2 when given an access token', () => {
  const t = buildTransport({ smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: true, smtpUser: 'jo@gmail.com', smtpFrom: 'jo@gmail.com' }, undefined, 'at-1')
  const auth = (t as unknown as { options: { auth?: Record<string, unknown> } }).options.auth
  assert.deepEqual(auth, { type: 'OAuth2', user: 'jo@gmail.com', accessToken: 'at-1' })
})
