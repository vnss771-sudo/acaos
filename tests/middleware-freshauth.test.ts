// Fast (no-DB) tests for the step-up freshness gate:
//   - requireFreshAuth middleware (apps/api/src/middleware/auth.ts)
//   - hasFreshAuth(userId) helper
//
// requireFreshAuth runs AFTER requireAuth, so it reads req.user and then queries
// prisma.user.findUnique({ select: { lastReauthAt } }). We exercise it via a tiny
// router that stubs req.user, mounted with the shared fake-Prisma harness — no
// PostgreSQL needed. The window is controlled with STEP_UP_MAX_AGE_MIN.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { Router, type Request, type Response, type NextFunction } from 'express'
import { requireFreshAuth, hasFreshAuth } from '../apps/api/src/middleware/auth.ts'
import {
  createFakePrisma,
  installPrisma,
  resetPrisma,
  startTestServer,
  type FakePrisma,
  type TestServer,
} from './helpers/integration.ts'

const USER = 'user-1'

// A fake user.findUnique that returns the configured lastReauthAt for USER. The
// production code selects only { lastReauthAt }, so that's all we need to model.
function specWithReauth(lastReauthAt: Date | null) {
  return {
    user: {
      findUnique: async (args: any) =>
        args?.where?.id === USER ? { lastReauthAt } : null,
    },
  }
}

// A router that stubs the requireAuth step (sets req.user) then gates on
// requireFreshAuth, so a 200 proves next() was reached.
function freshAuthRouter(userId: string | null) {
  const r = Router()
  r.post(
    '/protected',
    (req: Request, _res: Response, next: NextFunction) => {
      if (userId) (req as any).user = { id: userId, email: 'u@x.test' }
      next()
    },
    requireFreshAuth,
    (_req: Request, res: Response) => res.json({ ok: true })
  )
  return r
}

let server: TestServer
let prevWindow: string | undefined

beforeEach(() => {
  prevWindow = process.env.STEP_UP_MAX_AGE_MIN
})

afterEach(async () => {
  if (server) await server.close()
  resetPrisma()
  if (prevWindow === undefined) delete process.env.STEP_UP_MAX_AGE_MIN
  else process.env.STEP_UP_MAX_AGE_MIN = prevWindow
})

const post = () => server.request('/gate/protected', { method: 'POST' })

// ── requireFreshAuth middleware ───────────────────────────────────────────────

test('requireFreshAuth: lastReauthAt null → 403 REAUTH_REQUIRED', async () => {
  installPrisma(createFakePrisma(specWithReauth(null)) as FakePrisma)
  server = await startTestServer('/gate', freshAuthRouter(USER))
  const res = await post()
  assert.equal(res.status, 403)
  assert.equal(res.body.code, 'REAUTH_REQUIRED')
})

test('requireFreshAuth: lastReauthAt older than the window → 403 REAUTH_REQUIRED', async () => {
  process.env.STEP_UP_MAX_AGE_MIN = '15'
  // 60 minutes ago — well outside a 15-minute window.
  installPrisma(createFakePrisma(specWithReauth(new Date(Date.now() - 60 * 60_000))) as FakePrisma)
  server = await startTestServer('/gate', freshAuthRouter(USER))
  const res = await post()
  assert.equal(res.status, 403)
  assert.equal(res.body.code, 'REAUTH_REQUIRED')
})

test('requireFreshAuth: recent lastReauthAt → next()/200', async () => {
  process.env.STEP_UP_MAX_AGE_MIN = '15'
  // 1 minute ago — inside the window.
  installPrisma(createFakePrisma(specWithReauth(new Date(Date.now() - 60_000))) as FakePrisma)
  server = await startTestServer('/gate', freshAuthRouter(USER))
  const res = await post()
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { ok: true })
})

test('requireFreshAuth: no req.user (requireAuth not run) → 401', async () => {
  installPrisma(createFakePrisma(specWithReauth(new Date())) as FakePrisma)
  server = await startTestServer('/gate', freshAuthRouter(null))
  const res = await post()
  assert.equal(res.status, 401)
})

test('requireFreshAuth: STEP_UP_MAX_AGE_MIN widens the window so a stale proof passes', async () => {
  process.env.STEP_UP_MAX_AGE_MIN = '120' // 2 hours
  // 60 minutes ago — now inside the widened window.
  installPrisma(createFakePrisma(specWithReauth(new Date(Date.now() - 60 * 60_000))) as FakePrisma)
  server = await startTestServer('/gate', freshAuthRouter(USER))
  const res = await post()
  assert.equal(res.status, 200)
})

// ── hasFreshAuth(userId) helper ───────────────────────────────────────────────

test('hasFreshAuth: false when lastReauthAt is null', async () => {
  installPrisma(createFakePrisma(specWithReauth(null)) as FakePrisma)
  assert.equal(await hasFreshAuth(USER), false)
})

test('hasFreshAuth: false when lastReauthAt is older than the window', async () => {
  process.env.STEP_UP_MAX_AGE_MIN = '15'
  installPrisma(createFakePrisma(specWithReauth(new Date(Date.now() - 60 * 60_000))) as FakePrisma)
  assert.equal(await hasFreshAuth(USER), false)
})

test('hasFreshAuth: true when lastReauthAt is recent', async () => {
  process.env.STEP_UP_MAX_AGE_MIN = '15'
  installPrisma(createFakePrisma(specWithReauth(new Date(Date.now() - 60_000))) as FakePrisma)
  assert.equal(await hasFreshAuth(USER), true)
})

test('hasFreshAuth: false when the user row does not exist', async () => {
  installPrisma(createFakePrisma(specWithReauth(new Date())) as FakePrisma)
  assert.equal(await hasFreshAuth('nobody'), false)
})
