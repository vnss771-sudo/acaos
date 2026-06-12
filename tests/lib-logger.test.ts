// Tests for the structured logger and the requestContext middleware.

import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { logger } from '../apps/api/src/lib/logger.ts'
import { requestContext } from '../apps/api/src/middleware/requestContext.ts'
import type { Request, Response } from 'express'

// Capture stdout lines emitted by the logger.
function captureStdout<T>(fn: () => T): { out: string[]; result: T } {
  const out: string[] = []
  const original = process.stdout.write.bind(process.stdout)
  ;(process.stdout as any).write = (chunk: any) => { out.push(String(chunk)); return true }
  try { return { out, result: fn() } } finally { (process.stdout as any).write = original }
}

const SAVED_LEVEL = process.env.LOG_LEVEL
afterEach(() => {
  if (SAVED_LEVEL === undefined) delete process.env.LOG_LEVEL
  else process.env.LOG_LEVEL = SAVED_LEVEL
})

test('logger emits one JSON line with level, time, and msg', () => {
  process.env.LOG_LEVEL = 'info'
  const { out } = captureStdout(() => logger.info('hello', { foo: 'bar' }))
  assert.equal(out.length, 1)
  const rec = JSON.parse(out[0])
  assert.equal(rec.level, 'info')
  assert.equal(rec.msg, 'hello')
  assert.equal(rec.foo, 'bar')
  assert.ok(rec.time)
})

test('logger respects LOG_LEVEL threshold', () => {
  process.env.LOG_LEVEL = 'warn'
  const { out } = captureStdout(() => logger.info('suppressed'))
  assert.equal(out.length, 0)
})

test('child logger includes base fields on every line', () => {
  process.env.LOG_LEVEL = 'info'
  const { out } = captureStdout(() => logger.child({ requestId: 'req-1' }).info('x'))
  assert.equal(JSON.parse(out[0]).requestId, 'req-1')
})

test('logger serializes Error values without leaking stack', () => {
  process.env.LOG_LEVEL = 'info'
  const { out } = captureStdout(() => logger.info('boom', { err: new Error('secret') }))
  const rec = JSON.parse(out[0])
  assert.equal(rec.err.message, 'secret')
  assert.equal(rec.err.stack, undefined)
})

// --- requestContext middleware ---

function mockReqRes(headers: Record<string, string> = {}) {
  const resHeaders: Record<string, string> = {}
  let finishCb: (() => void) | undefined
  const req = { headers, method: 'GET', originalUrl: '/api/x?y=1' } as unknown as Request
  const res = {
    setHeader: (k: string, v: string) => { resHeaders[k] = v },
    on: (ev: string, cb: () => void) => { if (ev === 'finish') finishCb = cb },
    statusCode: 200,
  } as unknown as Response
  return { req, res, resHeaders, finish: () => finishCb?.() }
}

test('requestContext assigns a request id and echoes it on the response', () => {
  const { req, res, resHeaders } = mockReqRes()
  requestContext(req, res, () => {})
  assert.ok(req.id, 'request id assigned')
  assert.equal(resHeaders['X-Request-Id'], req.id)
  assert.ok(req.log, 'child logger attached')
})

test('requestContext honors an inbound X-Request-Id', () => {
  const { req, res } = mockReqRes({ 'x-request-id': 'caller-123' })
  requestContext(req, res, () => {})
  assert.equal(req.id, 'caller-123')
})

test('requestContext logs one access line on finish', () => {
  process.env.LOG_LEVEL = 'info'
  const { req, res, finish } = mockReqRes()
  const { out } = captureStdout(() => { requestContext(req, res, () => {}); finish() })
  const access = out.map((l) => JSON.parse(l)).find((r) => r.msg === 'request')
  assert.ok(access, 'access log emitted')
  assert.equal(access.method, 'GET')
  assert.equal(access.path, '/api/x') // query stripped
  assert.equal(access.status, 200)
})
