// Unit tests for Microsoft 365 sending through Graph (services/mail.ts
// sendViaGraph + sendMail routing) and per-resource tokens (lib/mailOAuth.ts).
// HTTP is faked; no SMTP or DNS is touched on the Graph path.

import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  clearMailAccessTokenCache, exchangeMailOAuthCode, getMailAccessToken, MailOAuthConsentError, type FetchLike,
} from '../packages/backend-core/src/lib/mailOAuth.ts'
import { sendMail, sendViaGraph } from '../packages/backend-core/src/services/mail.ts'

process.env.API_URL = 'https://api.acaos.test'
process.env.MICROSOFT_OAUTH_CLIENT_ID = 'mid'
process.env.MICROSOFT_OAUTH_CLIENT_SECRET = 'msecret'

const cfg = {
  workspaceId: 'w1', authMethod: 'MICROSOFT_OAUTH', oauthRefreshToken: 'rt-plain',
  smtpHost: 'smtp.office365.com', smtpPort: 587, smtpSecure: false, smtpUser: 'jo@contoso.com', smtpFrom: 'Jo <jo@contoso.com>',
}
const message = {
  from: 'Jo <jo@contoso.com>', to: 'buyer@x.test', subject: 'Quote for the fit-out', html: '<p>Hi</p>', text: 'Hi',
  headers: { 'List-Unsubscribe': '<https://api.acaos.test/u/abc>', 'In-Reply-To': '<prev@x.test>' },
}
const response = (status: number, json: unknown = {}) => new Response(status === 202 ? null : JSON.stringify(json), { status })

beforeEach(() => clearMailAccessTokenCache())
const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch; delete process.env.MICROSOFT_SEND_VIA_GRAPH })

test('sendViaGraph posts the full MIME message, so unsubscribe and threading headers survive', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const res = await sendViaGraph(cfg, message, {
    getAccessToken: async () => 'graph-token',
    fetch: (async (url: string, init: RequestInit) => { calls.push({ url, init }); return response(202) }) as never,
  })
  assert.equal(res?.transport, 'graph')
  assert.match(res!.messageId, /^<.+@.+>$/)
  assert.equal(calls[0].url, 'https://graph.microsoft.com/v1.0/me/sendMail')
  const headers = calls[0].init.headers as Record<string, string>
  assert.equal(headers.Authorization, 'Bearer graph-token')
  assert.equal(headers['Content-Type'], 'text/plain')
  const mime = Buffer.from(String(calls[0].init.body), 'base64').toString('utf8')
  assert.match(mime, /^List-Unsubscribe: <https:\/\/api\.acaos\.test\/u\/abc>\r$/m)
  assert.match(mime, /^In-Reply-To: <prev@x\.test>\r$/m)
  assert.match(mime, /^Subject: Quote for the fit-out\r$/m)
  assert.ok(mime.includes(`Message-ID: ${res!.messageId}`), 'the returned id is the one in the message (reply attribution)')
})

test('sendViaGraph returns null (try SMTP) only when Graph certainly did not send', async () => {
  const consentMissing = await sendViaGraph(cfg, message, { getAccessToken: async () => { throw new MailOAuthConsentError('AADSTS65001') } })
  assert.equal(consentMissing, null, 'grant without Graph consent')
  for (const status of [401, 403, 429]) {
    assert.equal(await sendViaGraph(cfg, message, { getAccessToken: async () => 't', fetch: (async () => response(status)) as never }), null, String(status))
  }
  await assert.rejects(
    sendViaGraph(cfg, message, { getAccessToken: async () => 't', fetch: (async () => response(503)) as never }),
    /Graph send failed \(503\)/, 'a 5xx may have sent: no fallback',
  )
  await assert.rejects(
    sendViaGraph(cfg, message, { getAccessToken: async () => 't', fetch: (async () => response(400, { error: { message: 'Bad MIME' } })) as never }),
    /\(400\): Bad MIME/,
  )
})

test('sendMail routes a signed-in Microsoft mailbox through Graph with a Graph-scoped token', async () => {
  const seen: string[] = []
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    seen.push(u)
    if (u.includes('/oauth2/v2.0/token')) {
      const form = new URLSearchParams(String(init?.body))
      assert.equal(form.get('scope'), 'https://graph.microsoft.com/Mail.Send offline_access')
      return new Response(JSON.stringify({ access_token: 'graph-at', expires_in: 3600 }), { status: 200 })
    }
    return response(202)
  }) as typeof fetch
  const res = await sendMail('buyer@x.test', 'Hello', '<p>Hi</p>', cfg) as { transport?: string; messageId: string }
  assert.equal(res.transport, 'graph')
  assert.deepEqual(seen.map(u => new URL(u).hostname), ['login.microsoftonline.com', 'graph.microsoft.com'])
})

test('per-resource tokens: mail and graph are requested and cached separately', async () => {
  const scopes: string[] = []
  const fakeFetch: FetchLike = async (_url, init) => {
    scopes.push(new URLSearchParams(String(init.body)).get('scope') ?? '')
    return new Response(JSON.stringify({ access_token: `at-${scopes.length}`, expires_in: 3600 }), { status: 200 })
  }
  const deps = { fetch: fakeFetch, persist: async () => {} }
  assert.equal(await getMailAccessToken(cfg, deps, 'mail'), 'at-1')
  assert.equal(await getMailAccessToken(cfg, deps, 'graph'), 'at-2')
  assert.equal(await getMailAccessToken(cfg, deps, 'mail'), 'at-1', 'cached per resource')
  assert.match(scopes[0], /IMAP\.AccessAsUser\.All/)
  assert.equal(scopes[1], 'https://graph.microsoft.com/Mail.Send offline_access')
})

test('a grant without Graph consent is not treated as revoked: no reconnect error is recorded', async () => {
  const persisted: unknown[] = []
  const fakeFetch: FetchLike = async () => new Response(JSON.stringify({
    error: 'invalid_grant', error_description: 'AADSTS65001: The user or administrator has not consented to use the application.',
  }), { status: 400 })
  await assert.rejects(getMailAccessToken(cfg, { fetch: fakeFetch, persist: async (_w, d) => { persisted.push(d) } }, 'graph'), MailOAuthConsentError)
  assert.deepEqual(persisted, [])
})

test('sign-in asks Microsoft for the IMAP/SMTP resource explicitly', async () => {
  let form = new URLSearchParams()
  const fakeFetch: FetchLike = async (_url, init) => {
    form = new URLSearchParams(String(init.body))
    const idToken = `h.${Buffer.from(JSON.stringify({ preferred_username: 'jo@contoso.com' })).toString('base64url')}.s`
    return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, id_token: idToken }), { status: 200 })
  }
  await exchangeMailOAuthCode('microsoft', 'code', fakeFetch)
  assert.equal(form.get('scope'), 'https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access')
})
