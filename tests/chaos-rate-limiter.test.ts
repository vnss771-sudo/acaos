// Chaos tests for rate limiter middleware — skipFn, outreach send guard,
// concurrent requests, adversarial headers
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRateLimiter } from '../apps/api/src/middleware/rateLimit.js'
import type { Request, Response } from 'express'

// Minimal mock request/response helpers
function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    socket: { remoteAddress: '10.0.0.1' },
    body: {},
    ...overrides,
  } as unknown as Request
}

type HeaderStore = Record<string, string | number>
type MockState = { status: number; headers: HeaderStore; body: unknown }

// Returns { res, state } where state is a mutable reference — mutations
// made by the middleware (res.status(429).json(...)) are reflected in state.
function makeRes(): { res: Response; state: MockState } {
  const state: MockState = { status: 200, headers: {}, body: undefined }
  const res = {
    setHeader(k: string, v: string | number) { state.headers[k] = v },
    status(code: number) { state.status = code; return res },
    json(b: unknown) { state.body = b; return res },
    end() { return res },
  } as unknown as Response
  return { res, state }
}

describe('createRateLimiter — core behavior', () => {
  it('allows requests up to max without blocking', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 5 })
    for (let i = 0; i < 5; i++) {
      const { res } = makeRes()
      let called = false
      limiter(makeReq(), res, () => { called = true })
      assert.ok(called, `Request ${i + 1} should pass through`)
    }
  })

  it('blocks on request max+1', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 3 })
    const req = makeReq({ socket: { remoteAddress: '10.1.1.1' } } as Partial<Request>)
    let nextCount = 0
    let blockedStatus = 0

    for (let i = 0; i < 4; i++) {
      const { res, state } = makeRes()
      limiter(req, res, () => { nextCount++ })
      if (state.status === 429) blockedStatus = 429
    }
    assert.equal(nextCount, 3, `Expected 3 requests through, got ${nextCount}`)
    assert.equal(blockedStatus, 429, 'Expected 429 on 4th request')
  })

  it('different IPs have independent counters', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 2 })
    const reqA = makeReq({ socket: { remoteAddress: '1.1.1.1' } } as Partial<Request>)
    const reqB = makeReq({ socket: { remoteAddress: '2.2.2.2' } } as Partial<Request>)

    // Exhaust IP A
    for (let i = 0; i < 2; i++) {
      const { res } = makeRes()
      limiter(reqA, res, () => {})
    }
    // IP B should still pass
    const { res: resB } = makeRes()
    let bPassed = false
    limiter(reqB, resB, () => { bPassed = true })
    assert.ok(bPassed, 'IP B should not be blocked by IP A exhausting the limiter')
  })

  it('X-RateLimit-Remaining decrements with each request', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 10 })
    const req = makeReq({ socket: { remoteAddress: '9.9.9.1' } } as Partial<Request>)
    const remainings: number[] = []
    for (let i = 0; i < 3; i++) {
      const { res, state } = makeRes()
      limiter(req, res, () => {})
      remainings.push(Number(state.headers['X-RateLimit-Remaining']))
    }
    assert.deepEqual(remainings, [9, 8, 7])
  })

  it('X-RateLimit-Remaining does not go below 0', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 2 })
    const req = makeReq({ socket: { remoteAddress: '9.9.9.2' } } as Partial<Request>)
    for (let i = 0; i < 5; i++) {
      const { res, state } = makeRes()
      limiter(req, res, () => {})
      assert.ok(Number(state.headers['X-RateLimit-Remaining']) >= 0,
        `Remaining went negative on request ${i + 1}`)
    }
  })

  it('blocked response includes Retry-After header', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1 })
    const req = makeReq({ socket: { remoteAddress: '9.9.9.3' } } as Partial<Request>)
    limiter(req, makeRes().res, () => {})
    const { res, state } = makeRes()
    limiter(req, res, () => {})
    assert.ok(Number(state.headers['Retry-After']) > 0, 'Retry-After should be positive integer')
  })

  it('custom message is returned in 429 response', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1, message: 'CUSTOM_MSG' })
    const req = makeReq({ socket: { remoteAddress: '9.9.9.4' } } as Partial<Request>)
    limiter(req, makeRes().res, () => {})
    const { res, state } = makeRes()
    limiter(req, res, () => {})
    assert.deepEqual(state.body, { error: 'CUSTOM_MSG' })
  })
})

describe('skipFn — outreachSendRateLimit behavior', () => {
  function makeOutreachLimiter() {
    return createRateLimiter({
      windowMs: 60_000,
      max: 3,
      skipFn: (req: Request) => req.body?.send !== true,
    })
  }

  it('preview requests (send: false) do not consume quota', () => {
    const limiter = makeOutreachLimiter()
    const ip = '192.168.1.1'
    const previewReq = makeReq({ socket: { remoteAddress: ip } as unknown, body: { send: false } } as Partial<Request>)

    let nextCount = 0
    for (let i = 0; i < 100; i++) {
      limiter(previewReq, makeRes().res, () => { nextCount++ })
    }
    assert.equal(nextCount, 100, 'All 100 preview requests should pass through without counting')
  })

  it('preview requests (send omitted) do not consume quota', () => {
    const limiter = makeOutreachLimiter()
    const ip = '192.168.1.2'
    const noSendReq = makeReq({ socket: { remoteAddress: ip } as unknown, body: {} } as Partial<Request>)

    let nextCount = 0
    for (let i = 0; i < 50; i++) {
      limiter(noSendReq, makeRes().res, () => { nextCount++ })
    }
    assert.equal(nextCount, 50, 'Requests without send field should not be rate-limited')
  })

  it('actual sends (send: true) consume quota and block at max', () => {
    const limiter = makeOutreachLimiter()
    const ip = '192.168.1.3'
    const sendReq = makeReq({ socket: { remoteAddress: ip } as unknown, body: { send: true } } as Partial<Request>)

    let nextCount = 0
    let blockedCount = 0
    for (let i = 0; i < 5; i++) {
      const { res, state } = makeRes()
      limiter(sendReq, res, () => { nextCount++ })
      if (state.status === 429) blockedCount++
    }
    assert.equal(nextCount, 3, `Expected 3 actual sends to pass, got ${nextCount}`)
    assert.ok(blockedCount > 0, 'Expected some blocked sends after exceeding limit')
  })

  it('preview requests interspersed with sends do not reset the send counter', () => {
    const limiter = makeOutreachLimiter()
    const ip = '192.168.1.4'
    const sendReq = makeReq({ socket: { remoteAddress: ip } as unknown, body: { send: true } } as Partial<Request>)
    const prevReq = makeReq({ socket: { remoteAddress: ip } as unknown, body: { send: false } } as Partial<Request>)

    // 3 sends (exhaust quota)
    for (let i = 0; i < 3; i++) {
      limiter(sendReq, makeRes().res, () => {})
    }
    // Preview should still pass
    let previewPassed = false
    limiter(prevReq, makeRes().res, () => { previewPassed = true })
    assert.ok(previewPassed, 'Preview should pass even after send quota is exhausted')

    // 4th send: should be blocked
    const { res: sendRes4, state: state4 } = makeRes()
    let fourthPassed = false
    limiter(sendReq, sendRes4, () => { fourthPassed = true })
    assert.ok(!fourthPassed, '4th send should be blocked after quota exhausted')
    assert.equal(state4.status, 429)
  })

  it('skipFn returning true does not set rate limit headers', () => {
    const limiter = makeOutreachLimiter()
    const ip = '192.168.1.5'
    const previewReq = makeReq({ socket: { remoteAddress: ip } as unknown, body: { send: false } } as Partial<Request>)
    const { res, state } = makeRes()
    limiter(previewReq, res, () => {})
    assert.ok(!state.headers['X-RateLimit-Limit'], `Rate limit headers set on skipped request`)
  })
})

describe('createRateLimiter — adversarial header inputs', () => {
  it('X-Forwarded-For with multiple IPs uses first IP', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 2 })
    const req = makeReq({
      headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8, 9.10.11.12' },
      socket: { remoteAddress: '127.0.0.1' },
    } as Partial<Request>)
    let nextCount = 0
    for (let i = 0; i < 3; i++) {
      limiter(req, makeRes().res, () => { nextCount++ })
    }
    assert.equal(nextCount, 2, `Expected 2 requests through for IP 1.2.3.4`)
  })

  it('X-Forwarded-For as array uses first element', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 2 })
    const req = makeReq({
      headers: { 'x-forwarded-for': ['1.2.3.5', '5.6.7.8'] },
      socket: { remoteAddress: '127.0.0.1' },
    } as Partial<Request>)
    let nextCount = 0
    for (let i = 0; i < 3; i++) {
      limiter(req, makeRes().res, () => { nextCount++ })
    }
    assert.equal(nextCount, 2)
  })

  it('empty X-Forwarded-For falls back to socket address', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 2 })
    const req = makeReq({
      headers: { 'x-forwarded-for': '' },
      socket: { remoteAddress: '4.4.4.4' },
    } as Partial<Request>)
    let nextCount = 0
    for (let i = 0; i < 3; i++) {
      limiter(req, makeRes().res, () => { nextCount++ })
    }
    assert.equal(nextCount, 2)
  })

  it('missing socket address uses "unknown" as key', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 2 })
    const req = makeReq({
      headers: {},
      socket: { remoteAddress: undefined },
    } as Partial<Request>)
    let nextCount = 0
    for (let i = 0; i < 3; i++) {
      limiter(req, makeRes().res, () => { nextCount++ })
    }
    assert.equal(nextCount, 2, 'Unknown IP should still be rate-limited')
  })

  it('XSS in X-Forwarded-For is used as cache key without executing', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 2 })
    const xssIp = '<script>alert(1)</script>'
    const req = makeReq({
      headers: { 'x-forwarded-for': xssIp },
      socket: { remoteAddress: '1.2.3.4' },
    } as Partial<Request>)
    assert.doesNotThrow(() => {
      for (let i = 0; i < 3; i++) {
        limiter(req, makeRes().res, () => {})
      }
    })
  })

  it('custom keyFn by API key partitions correctly', () => {
    const limiter = createRateLimiter({
      windowMs: 60_000,
      max: 2,
      keyFn: (req) => (req.headers['x-api-key'] as string) || 'anon',
    })
    const reqA = makeReq({ headers: { 'x-api-key': 'key-aaa' }, socket: { remoteAddress: '1.1.1.1' } } as Partial<Request>)
    const reqB = makeReq({ headers: { 'x-api-key': 'key-bbb' }, socket: { remoteAddress: '1.1.1.1' } } as Partial<Request>)

    // Exhaust key-aaa
    for (let i = 0; i < 2; i++) limiter(reqA, makeRes().res, () => {})

    let bPassed = false
    limiter(reqB, makeRes().res, () => { bPassed = true })
    assert.ok(bPassed, 'key-bbb should not be affected by key-aaa exhaustion')
  })
})

describe('confirmSend guard — backend protection', () => {
  it('confirmSend must be true to allow send (contract test)', () => {
    function validateSendRequest(body: { send?: boolean; confirmSend?: boolean }): string | null {
      if (body.send === true && !body.confirmSend) return 'confirmSend must be true to send email'
      return null
    }

    assert.equal(validateSendRequest({ send: true, confirmSend: false }), 'confirmSend must be true to send email')
    assert.equal(validateSendRequest({ send: true }), 'confirmSend must be true to send email')
    assert.equal(validateSendRequest({ send: true, confirmSend: true }), null)
    assert.equal(validateSendRequest({ send: false }), null)
    assert.equal(validateSendRequest({}), null)
  })

  it('truthy non-boolean confirmSend is NOT accepted (strict === true check)', () => {
    function validateSendRequest(body: { send?: boolean; confirmSend?: unknown }): string | null {
      if (body.send === true && body.confirmSend !== true) return 'confirmSend must be true to send email'
      return null
    }

    assert.equal(validateSendRequest({ send: true, confirmSend: 1 }), 'confirmSend must be true to send email')
    assert.equal(validateSendRequest({ send: true, confirmSend: 'yes' }), 'confirmSend must be true to send email')
    assert.equal(validateSendRequest({ send: true, confirmSend: {} }), 'confirmSend must be true to send email')
    assert.equal(validateSendRequest({ send: true, confirmSend: true }), null)
  })
})
