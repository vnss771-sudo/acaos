// Database-backed integration tests for MFA (TOTP) enrollment + the login
// second-factor challenge, and step-up re-authentication. Exercises the real
// routes, encrypted-secret storage, and the lastReauthAt freshness gate.

import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { authRouter } from '../apps/api/src/routes/auth.ts'
import { generateTotp } from '../packages/backend-core/src/lib/totp.ts'
import { prisma, resetDb, disconnect, startTestServer, type TestServer } from './helpers/db.ts'

let server: TestServer
let testIp: string
let ipCounter = 0

before(async () => { server = await startTestServer('/api/auth', authRouter) })
after(async () => { await server.close(); await disconnect() })
beforeEach(async () => {
  await resetDb()
  ipCounter += 1
  testIp = `10.1.${Math.floor(ipCounter / 256)}.${ipCounter % 256}`
})

const PASS = 'Sup3rSecret!'

const post = (path: string, body: unknown, token?: string) =>
  server.request(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': testIp,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })

const get = (path: string, token: string) =>
  server.request(path, { headers: { Authorization: `Bearer ${token}`, 'X-Forwarded-For': testIp } })

async function signupUser(email: string) {
  const res = await post('/api/auth/signup', { email, password: PASS, name: 'T' })
  assert.equal(res.status, 201, JSON.stringify(res.body))
  return res.body.token as string
}

/** Run the full enroll flow and return the user's TOTP secret. */
async function enrollMfa(token: string): Promise<string> {
  const setup = await post('/api/auth/mfa/setup', {}, token)
  assert.equal(setup.status, 200)
  const secret = setup.body.secret as string
  assert.match(setup.body.otpauthUri, /^otpauth:\/\/totp\//)
  const activate = await post('/api/auth/mfa/activate', { code: generateTotp(secret) }, token)
  assert.equal(activate.status, 200, JSON.stringify(activate.body))
  return secret
}

test('MFA secret is stored encrypted at rest, not as plaintext', async () => {
  const token = await signupUser('mfa-enc@x.test')
  const secret = await enrollMfa(token)
  const row = await prisma.user.findFirst({ where: { email: 'mfa-enc@x.test' }, select: { totpSecret: true, totpEnabled: true } })
  assert.equal(row?.totpEnabled, true)
  assert.ok(row?.totpSecret && row.totpSecret !== secret, 'stored secret must not equal the plaintext')
  assert.match(row!.totpSecret!, /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/, 'looks like an encrypted blob')
})

test('login with MFA enabled returns a challenge, not an access token', async () => {
  await signupUser('mfa-login@x.test')
  const tokenForSetup = (await post('/api/auth/login', { email: 'mfa-login@x.test', password: PASS })).body.token
  const secret = await enrollMfa(tokenForSetup)

  const login = await post('/api/auth/login', { email: 'mfa-login@x.test', password: PASS })
  assert.equal(login.status, 200)
  assert.equal(login.body.mfaRequired, true)
  assert.ok(login.body.mfaToken, 'returns a scoped MFA token')
  assert.equal(login.body.token, undefined, 'no access token before the second factor')

  // The MFA token must NOT work as a Bearer access token.
  const meWithMfaToken = await get('/api/auth/me', login.body.mfaToken)
  assert.equal(meWithMfaToken.status, 401)

  // Wrong code is rejected; correct code completes the login.
  assert.equal((await post('/api/auth/verify-totp', { mfaToken: login.body.mfaToken, code: '000000' })).status, 401)
  const verified = await post('/api/auth/verify-totp', { mfaToken: login.body.mfaToken, code: generateTotp(secret) })
  assert.equal(verified.status, 200, JSON.stringify(verified.body))
  assert.ok(verified.body.token, 'issues an access token after the second factor')
  assert.equal((await get('/api/auth/me', verified.body.token)).status, 200)
})

test('a TOTP code cannot be replayed at login (single-use / anti-replay)', async () => {
  await signupUser('mfa-replay@x.test')
  const tokenForSetup = (await post('/api/auth/login', { email: 'mfa-replay@x.test', password: PASS })).body.token
  const secret = await enrollMfa(tokenForSetup)
  const code = generateTotp(secret)

  // First login with the code succeeds and consumes its time-step.
  const login1 = await post('/api/auth/login', { email: 'mfa-replay@x.test', password: PASS })
  const v1 = await post('/api/auth/verify-totp', { mfaToken: login1.body.mfaToken, code })
  assert.equal(v1.status, 200, JSON.stringify(v1.body))

  // Replaying the SAME code on a fresh challenge (still within its validity window)
  // is rejected — the step was already consumed.
  const login2 = await post('/api/auth/login', { email: 'mfa-replay@x.test', password: PASS })
  const v2 = await post('/api/auth/verify-totp', { mfaToken: login2.body.mfaToken, code })
  assert.equal(v2.status, 401, 'a replayed TOTP code must be rejected')
})

test('progressive lockout: repeated wrong codes lock the account; success clears it', async () => {
  // Isolate from the IP rate limiter so we exercise the per-account lockout itself.
  const savedRl = process.env.RATE_LIMIT_DISABLED
  process.env.RATE_LIMIT_DISABLED = 'true'
  try {
    const email = 'mfa-lock@x.test'
    await signupUser(email)
    const tokenForSetup = (await post('/api/auth/login', { email, password: PASS })).body.token
    const secret = await enrollMfa(tokenForSetup)
    const userId = (await prisma.user.findFirstOrThrow({ where: { email } })).id

    // Seed 4 prior failures so the next wrong code is the 5th → first lock kicks in.
    await prisma.user.update({ where: { id: userId }, data: { failedMfaAttempts: 4 } })

    const login = await post('/api/auth/login', { email, password: PASS })
    const wrong = await post('/api/auth/verify-totp', { mfaToken: login.body.mfaToken, code: '000000' })
    assert.equal(wrong.status, 401)
    let row = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
    assert.equal(row.failedMfaAttempts, 5)
    assert.ok(row.mfaLockedUntil && row.mfaLockedUntil > new Date(), 'account is now locked')

    // While locked, even a CORRECT code is rejected (429) before it is consumed.
    const login2 = await post('/api/auth/login', { email, password: PASS })
    const locked = await post('/api/auth/verify-totp', { mfaToken: login2.body.mfaToken, code: generateTotp(secret) })
    assert.equal(locked.status, 429)
    assert.match(String(locked.body.error), /temporarily locked/i)

    // Simulate the lock window elapsing; the correct code now succeeds and resets state.
    await prisma.user.update({ where: { id: userId }, data: { mfaLockedUntil: new Date(Date.now() - 1000) } })
    const login3 = await post('/api/auth/login', { email, password: PASS })
    const ok = await post('/api/auth/verify-totp', { mfaToken: login3.body.mfaToken, code: generateTotp(secret) })
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    row = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
    assert.equal(row.failedMfaAttempts, 0, 'counter reset on success')
    assert.equal(row.mfaLockedUntil, null, 'lock cleared on success')
  } finally {
    if (savedRl === undefined) delete process.env.RATE_LIMIT_DISABLED
    else process.env.RATE_LIMIT_DISABLED = savedRl
  }
})

test('activate rejects a wrong code and leaves MFA disabled', async () => {
  const token = await signupUser('mfa-bad@x.test')
  await post('/api/auth/mfa/setup', {}, token)
  const bad = await post('/api/auth/mfa/activate', { code: '000000' }, token)
  assert.equal(bad.status, 400)
  const row = await prisma.user.findFirst({ where: { email: 'mfa-bad@x.test' }, select: { totpEnabled: true } })
  assert.equal(row?.totpEnabled, false)
})

test('step-up: mfa/disable requires fresh auth and reauth refreshes it', async () => {
  const token = await signupUser('mfa-disable@x.test')
  const secret = await enrollMfa(token)
  const userId = (await prisma.user.findFirstOrThrow({ where: { email: 'mfa-disable@x.test' } })).id

  // Make the last credential proof stale → disable must be blocked.
  await prisma.user.update({ where: { id: userId }, data: { lastReauthAt: new Date(Date.now() - 60 * 60_000) } })
  const blocked = await post('/api/auth/mfa/disable', {}, token)
  assert.equal(blocked.status, 403)
  assert.equal(blocked.body.code, 'REAUTH_REQUIRED')

  // Re-auth (password + code, since MFA is on) refreshes the window.
  assert.equal((await post('/api/auth/reauth', { password: 'wrong', code: generateTotp(secret) }, token)).status, 401)
  const reauth = await post('/api/auth/reauth', { password: PASS, code: generateTotp(secret) }, token)
  assert.equal(reauth.status, 200, JSON.stringify(reauth.body))

  // Now disable succeeds and clears the secret.
  const disabled = await post('/api/auth/mfa/disable', {}, token)
  assert.equal(disabled.status, 200)
  const row = await prisma.user.findFirst({ where: { id: userId }, select: { totpEnabled: true, totpSecret: true } })
  assert.equal(row?.totpEnabled, false)
  assert.equal(row?.totpSecret, null)
  // Disabling a credential factor revokes all active refresh tokens.
  const active = await prisma.refreshToken.count({ where: { userId, revokedAt: null } })
  assert.equal(active, 0, 'all refresh tokens revoked after MFA disable')
})
