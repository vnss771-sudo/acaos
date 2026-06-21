import test from 'node:test'
import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { createRateLimiter, authRateLimit } from '../apps/api/src/middleware/rateLimit.ts'
import type { Request, Response, NextFunction } from 'express'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeReq(ip = '1.2.3.4'): Request {
  return {
    headers: {},
    socket: { remoteAddress: ip }
  } as unknown as Request
}

function makeRes() {
  const headers: Record<string, string | number> = {}
  const setHeader = mock.fn((k: string, v: string | number) => { headers[k] = v })
  const json = mock.fn()
  const status = mock.fn((_code: number) => ({ json }))
  return { res: { setHeader, status, json } as unknown as Response, headers, setHeader, status, json }
}

async function runMiddleware(
  limiter: ReturnType<typeof createRateLimiter>,
  req: Request,
  res: Response
): Promise<{ nextCalled: boolean; nextArg: unknown }> {
  return new Promise((resolve) => {
    const next = mock.fn<NextFunction>((arg?: unknown) => resolve({ nextCalled: true, nextArg: arg }))
    limiter(req, res, next)
    // Synchronous middleware — if next not called, res.status was called
    setImmediate(() => resolve({ nextCalled: false, nextArg: undefined }))
  })
}

// ---------------------------------------------------------------------------
// Basic pass-through
// ---------------------------------------------------------------------------
test('rate limiter: first request passes through (calls next)', async () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 5 })
  const { res } = makeRes()
  const { nextCalled } = await runMiddleware(limiter, makeReq(), res)
  assert.equal(nextCalled, true)
})

test('rate limiter: requests up to max all pass through', async () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 3 })
  const req = makeReq('5.5.5.5')
  for (let i = 0; i < 3; i++) {
    const { res } = makeRes()
    const { nextCalled } = await runMiddleware(limiter, req, res)
    assert.equal(nextCalled, true, `request ${i + 1} should pass`)
  }
})

// ---------------------------------------------------------------------------
// Blocking at limit+1
// ---------------------------------------------------------------------------
test('rate limiter: request one over max returns 429', async () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 2 })
  const req = makeReq('9.9.9.9')
  for (let i = 0; i < 2; i++) {
    const { res } = makeRes()
    await runMiddleware(limiter, req, res)
  }
  const { res, status } = makeRes()
  const { nextCalled } = await runMiddleware(limiter, req, res)
  assert.equal(nextCalled, false)
  assert.equal(status.mock.calls[0].arguments[0], 429)
})

test('rate limiter: blocked response has custom message', async () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 1, message: 'Slow down!' })
  const req = makeReq('8.8.8.8')
  const { res: res1 } = makeRes()
  await runMiddleware(limiter, req, res1)  // exhaust the 1 request
  const { res: res2, json } = makeRes()
  await runMiddleware(limiter, req, res2)
  assert.deepEqual(json.mock.calls[0].arguments[0], { error: 'Slow down!' })
})

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------
test('rate limiter: sets X-RateLimit-Limit header', async () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 10 })
  const { res, headers } = makeRes()
  await runMiddleware(limiter, makeReq('11.11.11.11'), res)
  assert.equal(headers['X-RateLimit-Limit'], 10)
})

test('rate limiter: X-RateLimit-Remaining decrements with each request', async () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 5 })
  const req = makeReq('22.22.22.22')

  const { res: res1, headers: h1 } = makeRes()
  await runMiddleware(limiter, req, res1)
  assert.equal(h1['X-RateLimit-Remaining'], 4)

  const { res: res2, headers: h2 } = makeRes()
  await runMiddleware(limiter, req, res2)
  assert.equal(h2['X-RateLimit-Remaining'], 3)
})

test('rate limiter: X-RateLimit-Remaining does not go below 0 on 429', async () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 1 })
  const req = makeReq('33.33.33.33')
  const { res: res1 } = makeRes()
  await runMiddleware(limiter, req, res1)  // uses the 1 slot

  const { res: res2, headers: h2 } = makeRes()
  await runMiddleware(limiter, req, res2)  // over limit
  assert.ok((h2['X-RateLimit-Remaining'] as number) >= 0)
})

test('rate limiter: sets X-RateLimit-Reset header (positive integer)', async () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 5 })
  const { res, headers } = makeRes()
  await runMiddleware(limiter, makeReq('44.44.44.44'), res)
  assert.ok(typeof headers['X-RateLimit-Reset'] === 'number')
  assert.ok((headers['X-RateLimit-Reset'] as number) > 0)
})

test('rate limiter: 429 response includes Retry-After header', async () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 1 })
  const req = makeReq('55.55.55.55')
  const { res: res1 } = makeRes()
  await runMiddleware(limiter, req, res1)

  const extraHeaders: Record<string, string | number> = {}
  const { res: res2, status: status2 } = makeRes()
  ;(res2 as any).setHeader = (k: string, v: string | number) => { extraHeaders[k] = v }
  await runMiddleware(limiter, req, res2)
  assert.equal(status2.mock.calls[0]?.arguments[0], 429, 'should be rate limited')
  // Retry-After is set via res.setHeader before the 429 response
  assert.ok('Retry-After' in extraHeaders, 'Retry-After header should be set on 429')
})

// ---------------------------------------------------------------------------
// IP isolation
// ---------------------------------------------------------------------------
test('rate limiter: different IPs have independent counters', async () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 2 })
  const reqA = makeReq('100.0.0.1')
  const reqB = makeReq('100.0.0.2')

  // Exhaust IP A
  for (let i = 0; i < 2; i++) {
    const { res } = makeRes()
    await runMiddleware(limiter, reqA, res)
  }
  const { res: resABlocked, status: statusA } = makeRes()
  await runMiddleware(limiter, reqA, resABlocked)
  assert.equal(statusA.mock.calls[0]?.arguments[0], 429, 'IP A should be blocked')

  // IP B is unaffected
  const { res: resB } = makeRes()
  const { nextCalled } = await runMiddleware(limiter, reqB, resB)
  assert.equal(nextCalled, true, 'IP B should still pass')
})

// ---------------------------------------------------------------------------
// Custom keyFn
// ---------------------------------------------------------------------------
test('rate limiter: custom keyFn partitions requests correctly', async () => {
  const limiter = createRateLimiter({
    windowMs: 60_000,
    max: 1,
    keyFn: (req) => (req as any).customKey ?? 'default'
  })

  const reqA = { headers: {}, socket: {}, customKey: 'user-a' } as any
  const reqB = { headers: {}, socket: {}, customKey: 'user-b' } as any

  const { res: r1 } = makeRes()
  await runMiddleware(limiter, reqA, r1)  // user-a: 1/1 used

  const { res: r2, status: s2 } = makeRes()
  await runMiddleware(limiter, reqA, r2)  // user-a: blocked
  assert.equal(s2.mock.calls[0]?.arguments[0], 429)

  const { res: r3 } = makeRes()
  const { nextCalled } = await runMiddleware(limiter, reqB, r3)  // user-b: fresh
  assert.equal(nextCalled, true)
})

// ---------------------------------------------------------------------------
// Client IP keying (must not trust a raw, spoofable X-Forwarded-For header)
// ---------------------------------------------------------------------------
test('rate limiter: keys on the framework-resolved req.ip', async () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 1 })
  // Express sets req.ip from the trusted-proxy chain; the limiter must use it.
  const req = { headers: {}, ip: '203.0.113.9', socket: {} } as unknown as Request

  const { res: r1 } = makeRes()
  await runMiddleware(limiter, req, r1)

  const { res: r2, status } = makeRes()
  await runMiddleware(limiter, req, r2)
  assert.equal(status.mock.calls[0]?.arguments[0], 429)
})

test('rate limiter: a spoofed X-Forwarded-For header does NOT create new buckets', async () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 1 })
  // Same resolved client (req.ip), but attacker rotates the raw header each call.
  const mk = (xff: string) =>
    ({ headers: { 'x-forwarded-for': xff }, ip: '198.51.100.7', socket: { remoteAddress: '198.51.100.7' } }) as unknown as Request

  const { res: r1 } = makeRes()
  await runMiddleware(limiter, mk('1.1.1.1'), r1)

  const { res: r2, status } = makeRes()
  await runMiddleware(limiter, mk('2.2.2.2'), r2) // different spoofed header, same req.ip
  assert.equal(status.mock.calls[0]?.arguments[0], 429, 'spoofing the header must not bypass the limit')
})

// ---------------------------------------------------------------------------
// keyFn returning null skips limiting (finding #9 per-account: no account → skip)
// ---------------------------------------------------------------------------
test('rate limiter: keyFn returning null skips limiting entirely', async () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 1, keyFn: () => null })
  const req = makeReq('88.0.0.1')
  for (let i = 0; i < 5; i++) {
    const { res, headers } = makeRes()
    const { nextCalled } = await runMiddleware(limiter, req, res)
    assert.equal(nextCalled, true, `request ${i + 1} passes (no bucket)`)
    assert.equal(headers['X-RateLimit-Limit'], undefined, 'no rate headers when skipped')
  }
})

// ---------------------------------------------------------------------------
// degradedMax: tighten on the Redis fallback, but only in production
// ---------------------------------------------------------------------------
test('rate limiter: degradedMax tightens the fallback ceiling in production', async () => {
  const prev = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  try {
    // Unit env has no Redis, so every request takes the in-process fallback path.
    const limiter = createRateLimiter({ windowMs: 60_000, max: 10, degradedMax: 2 })
    const req = makeReq('77.0.0.1')
    for (let i = 0; i < 2; i++) {
      const { res } = makeRes()
      const { nextCalled } = await runMiddleware(limiter, req, res)
      assert.equal(nextCalled, true, `request ${i + 1} within degradedMax passes`)
    }
    const { res, status, headers } = makeRes()
    const { nextCalled } = await runMiddleware(limiter, req, res)
    assert.equal(nextCalled, false, '3rd request blocked at degradedMax=2')
    assert.equal(status.mock.calls[0]?.arguments[0], 429)
    assert.equal(headers['X-RateLimit-Limit'], 2, 'header reflects the tightened ceiling')
  } finally {
    process.env.NODE_ENV = prev
  }
})

test('rate limiter: degradedMax is ignored outside production (full max applies)', async () => {
  // NODE_ENV is 'test' here, so degradedMax must NOT apply — the real max wins.
  const limiter = createRateLimiter({ windowMs: 60_000, max: 3, degradedMax: 1 })
  const req = makeReq('77.0.0.2')
  for (let i = 0; i < 3; i++) {
    const { res } = makeRes()
    const { nextCalled } = await runMiddleware(limiter, req, res)
    assert.equal(nextCalled, true, `request ${i + 1} passes at full max`)
  }
  const { res, status } = makeRes()
  const { nextCalled } = await runMiddleware(limiter, req, res)
  assert.equal(nextCalled, false, '4th request blocked at full max=3 (degradedMax ignored)')
  assert.equal(status.mock.calls[0]?.arguments[0], 429)
})

// ---------------------------------------------------------------------------
// authRateLimit: per-account dimension (finding #9)
// ---------------------------------------------------------------------------
test('authRateLimit: one account is throttled even across rotating IPs', async () => {
  const email = 'victim@example.com'
  const mk = (ip: string) =>
    ({ headers: {}, ip, socket: { remoteAddress: ip }, body: { email } }) as unknown as Request

  // 10 attempts on the SAME account, each from a fresh IP. The per-IP limiter sees
  // only 1 per IP, but the per-account limiter counts all 10.
  for (let i = 0; i < 10; i++) {
    const { res } = makeRes()
    const { nextCalled } = await runMiddleware(authRateLimit, mk(`9.9.9.${i}`), res)
    assert.equal(nextCalled, true, `attempt ${i + 1} (new IP) passes`)
  }
  // 11th attempt on the same account from yet another new IP — blocked per-account.
  const { res, status } = makeRes()
  const { nextCalled } = await runMiddleware(authRateLimit, mk('9.9.9.250'), res)
  assert.equal(nextCalled, false, '11th attempt on the same account is blocked')
  assert.equal(status.mock.calls[0]?.arguments[0], 429)
})

test('authRateLimit: requests without an email skip the per-account limiter', async () => {
  // e.g. /refresh or /verify-totp carry no email; only the per-IP window applies.
  const mk = () => ({ headers: {}, ip: '10.0.0.9', socket: { remoteAddress: '10.0.0.9' }, body: {} }) as unknown as Request
  for (let i = 0; i < 10; i++) {
    const { res } = makeRes()
    const { nextCalled } = await runMiddleware(authRateLimit, mk(), res)
    assert.equal(nextCalled, true, `request ${i + 1} passes the per-IP window`)
  }
  // 11th from the same IP trips the per-IP limiter (max 10), proving the chain runs.
  const { res, status } = makeRes()
  const { nextCalled } = await runMiddleware(authRateLimit, mk(), res)
  assert.equal(nextCalled, false)
  assert.equal(status.mock.calls[0]?.arguments[0], 429)
})
