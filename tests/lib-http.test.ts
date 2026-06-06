import test from 'node:test'
import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { ApiError, asyncHandler, notFoundHandler, errorHandler } from '../apps/api/src/lib/http.ts'
import type { Request, Response, NextFunction } from 'express'

// ---------------------------------------------------------------------------
// ApiError
// ---------------------------------------------------------------------------
test('ApiError stores statusCode and message', () => {
  const err = new ApiError(404, 'Not found')
  assert.equal(err.statusCode, 404)
  assert.equal(err.message, 'Not found')
})

test('ApiError name is ApiError', () => {
  assert.equal(new ApiError(400, 'bad').name, 'ApiError')
})

test('ApiError is instanceof Error', () => {
  assert.ok(new ApiError(500, 'oops') instanceof Error)
})

test('ApiError stores arbitrary 4xx and 5xx codes', () => {
  assert.equal(new ApiError(400, '').statusCode, 400)
  assert.equal(new ApiError(403, '').statusCode, 403)
  assert.equal(new ApiError(409, '').statusCode, 409)
  assert.equal(new ApiError(422, '').statusCode, 422)
  assert.equal(new ApiError(503, '').statusCode, 503)
})

// ---------------------------------------------------------------------------
// asyncHandler
// ---------------------------------------------------------------------------
function fakeRes() {
  const json = mock.fn()
  const status = mock.fn(() => ({ json }))
  return { res: { status, json } as unknown as Response, status, json }
}

function fakeReqRes() {
  const req = {} as Request
  const { res, status, json } = fakeRes()
  const next = mock.fn<NextFunction>()
  return { req, res, next, status, json }
}

test('asyncHandler invokes the handler with req, res, next', async () => {
  const handler = mock.fn(async (_req: Request, _res: Response, _next: NextFunction) => {})
  const { req, res, next } = fakeReqRes()
  const wrapped = asyncHandler(handler)
  wrapped(req, res, next)
  await new Promise(setImmediate)
  assert.equal(handler.mock.callCount(), 1)
  assert.equal(handler.mock.calls[0].arguments[0], req)
  assert.equal(handler.mock.calls[0].arguments[1], res)
})

test('asyncHandler calls next(err) when handler throws', async () => {
  const boom = new Error('boom')
  const wrapped = asyncHandler(async () => { throw boom })
  const { req, res, next } = fakeReqRes()
  wrapped(req, res, next)
  await new Promise(setImmediate)
  assert.equal(next.mock.callCount(), 1)
  assert.equal(next.mock.calls[0].arguments[0], boom)
})

test('asyncHandler calls next(err) on rejected promise', async () => {
  const wrapped = asyncHandler(() => Promise.reject(new ApiError(400, 'rejected')))
  const { req, res, next } = fakeReqRes()
  wrapped(req, res, next)
  await new Promise(setImmediate)
  assert.equal(next.mock.callCount(), 1)
  assert.ok(next.mock.calls[0].arguments[0] instanceof ApiError)
})

test('asyncHandler does NOT call next when handler succeeds', async () => {
  const wrapped = asyncHandler(async (_req, res) => { res.json({ ok: true }) })
  const { req, res, next } = fakeReqRes()
  ;(res as any).json = mock.fn()
  wrapped(req, res, next)
  await new Promise(setImmediate)
  assert.equal(next.mock.callCount(), 0)
})

// ---------------------------------------------------------------------------
// notFoundHandler
// ---------------------------------------------------------------------------
test('notFoundHandler returns 404 with JSON error', () => {
  const json = mock.fn()
  const status = mock.fn(() => ({ json }))
  const res = { status } as unknown as Response
  notFoundHandler({} as Request, res)
  assert.equal(status.mock.calls[0].arguments[0], 404)
  assert.deepEqual(json.mock.calls[0].arguments[0], { error: 'Not found' })
})

// ---------------------------------------------------------------------------
// errorHandler
// ---------------------------------------------------------------------------
function runErrorHandler(error: unknown, nodeEnv?: string) {
  const saved = process.env.NODE_ENV
  if (nodeEnv !== undefined) process.env.NODE_ENV = nodeEnv
  else delete process.env.NODE_ENV

  const json = mock.fn()
  const status = mock.fn(() => ({ json }))
  const res = { status } as unknown as Response

  try {
    errorHandler(error, {} as Request, res, (() => {}) as NextFunction)
    return {
      statusCode: status.mock.calls[0].arguments[0] as number,
      body: json.mock.calls[0].arguments[0] as Record<string, string>
    }
  } finally {
    process.env.NODE_ENV = saved
  }
}

test('errorHandler returns ApiError statusCode and message', () => {
  const result = runErrorHandler(new ApiError(422, 'Unprocessable'))
  assert.equal(result.statusCode, 422)
  assert.equal(result.body.error, 'Unprocessable')
})

test('errorHandler returns 400 for ApiError 400', () => {
  const result = runErrorHandler(new ApiError(400, 'Bad request'))
  assert.equal(result.statusCode, 400)
})

test('errorHandler returns 500 for unknown Error in development', () => {
  const result = runErrorHandler(new Error('db exploded'), 'development')
  assert.equal(result.statusCode, 500)
  assert.equal(result.body.error, 'db exploded')
})

test('errorHandler masks error message in production', () => {
  const result = runErrorHandler(new Error('secret stack trace'), 'production')
  assert.equal(result.statusCode, 500)
  assert.equal(result.body.error, 'Internal server error')
})

test('errorHandler returns generic message for non-Error thrown values', () => {
  const result = runErrorHandler('a bare string error', 'development')
  assert.equal(result.statusCode, 500)
  assert.equal(result.body.error, 'Internal server error')
})

test('errorHandler returns generic message for null', () => {
  const result = runErrorHandler(null, 'development')
  assert.equal(result.statusCode, 500)
  assert.equal(result.body.error, 'Internal server error')
})

test('errorHandler returns generic message for Error with no message in production', () => {
  const result = runErrorHandler(new Error(''), 'production')
  assert.equal(result.statusCode, 500)
  assert.equal(result.body.error, 'Internal server error')
})
