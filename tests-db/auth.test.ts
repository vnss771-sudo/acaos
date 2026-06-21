// Database-backed integration tests for /api/auth.
//
// Exercises the real signup transaction (user + workspace + membership), the
// unique email/slug constraints, and refresh-token rotation against actual
// rows — the parts most likely to diverge from a fake.

import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { authRouter } from '../apps/api/src/routes/auth.ts'
import { prisma, resetDb, disconnect, startTestServer, type TestServer } from './helpers/db.ts'

let server: TestServer
// The auth routes are rate-limited per client IP. Give each test a distinct
// forwarded IP so one test's request volume can't trip the limit for the next.
let testIp: string
let ipCounter = 0

before(async () => {
  server = await startTestServer('/api/auth', authRouter)
})
after(async () => {
  await server.close()
  await disconnect()
})
beforeEach(async () => {
  await resetDb()
  ipCounter += 1
  testIp = `10.0.${Math.floor(ipCounter / 256)}.${ipCounter % 256}`
})

const post = (path: string, body: unknown) =>
  server.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': testIp },
    body: JSON.stringify(body),
  })

// Refresh/logout authenticate via the HttpOnly cookie + CSRF header.
const postWithRefreshCookie = (path: string, rawRefresh: string, opts: { csrf?: boolean } = {}) =>
  server.request(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': testIp,
      Cookie: `acaos_refresh=${rawRefresh}`,
      ...(opts.csrf === false ? {} : { 'X-CSRF-Protection': '1' }),
    },
  })

function refreshCookieFrom(headers: Headers): string | null {
  const raw = headers.get('set-cookie')
  if (!raw) return null
  const m = raw.match(/acaos_refresh=([^;]+)/)
  return m ? m[1] : null
}

test('signup persists user, workspace, owner membership, and a refresh token', async () => {
  const res = await post('/api/auth/signup', { email: 'Founder@Acme.test', password: 'sup3rsecret1', name: 'Fred' })
  assert.equal(res.status, 201)

  const user = await prisma.user.findUnique({
    where: { email: 'founder@acme.test' },
    include: { memberships: { include: { workspace: true } }, refreshTokens: true },
  })
  assert.ok(user, 'user row created')
  assert.equal(user!.memberships.length, 1)
  assert.equal(user!.memberships[0].role, 'owner')
  assert.ok(user!.memberships[0].workspace.slug, 'workspace has a slug')
  assert.equal(user!.refreshTokens.length, 1)
  // The refresh token is delivered as an HttpOnly cookie (never in the body)...
  assert.equal(res.body.refreshToken, undefined)
  const cookie = refreshCookieFrom(res.headers)
  assert.ok(cookie, 'refresh token set as a cookie')
  // ...and stored hashed, never as the raw cookie value.
  assert.notEqual(user!.refreshTokens[0].tokenHash, cookie)
})

test('signup is rejected for a duplicate email (unique constraint upheld)', async () => {
  await post('/api/auth/signup', { email: 'dupe@acme.test', password: 'sup3rsecret1' })
  const res = await post('/api/auth/signup', { email: 'dupe@acme.test', password: 'sup3rsecret1' })
  assert.equal(res.status, 409)
  assert.equal(await prisma.user.count(), 1)
})

test('two signups produce distinct, unique workspace slugs', async () => {
  await post('/api/auth/signup', { email: 'a@acme.test', password: 'sup3rsecret1', name: 'Acme' })
  await post('/api/auth/signup', { email: 'b@acme.test', password: 'sup3rsecret1', name: 'Acme' })
  const slugs = await prisma.workspace.findMany({ select: { slug: true } })
  assert.equal(slugs.length, 2)
  assert.notEqual(slugs[0].slug, slugs[1].slug)
})

test('refresh reuse detection: replaying a revoked token revokes the whole family', async () => {
  await post('/api/auth/signup', { email: 'rot@acme.test', password: 'sup3rsecret1' })
  const login = await post('/api/auth/login', { email: 'rot@acme.test', password: 'sup3rsecret1' })
  assert.equal(login.status, 200)

  const first = refreshCookieFrom(login.headers)
  assert.ok(first, 'login sets a refresh cookie')

  // Rotate once: the old cookie is revoked, a new one is issued.
  const refresh = await postWithRefreshCookie('/api/auth/refresh', first!)
  assert.equal(refresh.status, 200)
  const rotated = refreshCookieFrom(refresh.headers)
  assert.ok(rotated && rotated !== first, 'refresh rotates the cookie')

  // Replaying the OLD (already-revoked) token is a theft signal. It 401s AND
  // triggers reuse detection, which revokes the user's entire refresh-token
  // family — including the freshly rotated token that had not yet been used.
  const reuseOld = await postWithRefreshCookie('/api/auth/refresh', first!)
  assert.equal(reuseOld.status, 401)

  // The rotated token is now dead too: the family was revoked, so it cannot be
  // used to mint a new session. The legitimate user must re-authenticate.
  const useRotated = await postWithRefreshCookie('/api/auth/refresh', rotated!)
  assert.equal(useRotated.status, 401)

  const revokedCount = await prisma.refreshToken.count({ where: { revokedAt: { not: null } } })
  assert.ok(revokedCount >= 2)
})

test('chained refresh: each rotated cookie is usable for the next refresh', async () => {
  await post('/api/auth/signup', { email: 'chain@acme.test', password: 'sup3rsecret1' })
  const login = await post('/api/auth/login', { email: 'chain@acme.test', password: 'sup3rsecret1' })
  assert.equal(login.status, 200)

  // Use each freshly rotated cookie immediately (never replaying an old one), so
  // reuse detection is never tripped and every rotation succeeds in turn.
  let cookie = refreshCookieFrom(login.headers)
  assert.ok(cookie, 'login sets a refresh cookie')
  for (let i = 0; i < 3; i++) {
    const res = await postWithRefreshCookie('/api/auth/refresh', cookie!)
    assert.equal(res.status, 200)
    const next = refreshCookieFrom(res.headers)
    assert.ok(next && next !== cookie, 'each refresh rotates to a new cookie')
    cookie = next
  }
})

test('login rejects a wrong password against the stored bcrypt hash', async () => {
  await post('/api/auth/signup', { email: 'pw@acme.test', password: 'correct-horse' })
  const res = await post('/api/auth/login', { email: 'pw@acme.test', password: 'wrong-horse' })
  assert.equal(res.status, 401)
})
