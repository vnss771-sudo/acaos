import test from 'node:test'
import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { createRateLimiter } from '../apps/api/src/middleware/rateLimit.ts'
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
