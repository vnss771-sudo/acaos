// Verifies the metrics middleware records the matched route pattern (not the
// concrete URL) and manages the in-flight gauge across the response lifecycle.

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { Request, Response, NextFunction } from 'express'
import { metricsMiddleware } from '../apps/api/src/middleware/metrics.ts'
import { renderMetrics, resetMetrics } from '../apps/api/src/lib/metrics.ts'

beforeEach(() => resetMetrics())

function fakeReqRes(opts: { method: string; baseUrl: string; routePath?: string }) {
  const req = { method: opts.method, baseUrl: opts.baseUrl, route: opts.routePath ? { path: opts.routePath } : undefined } as unknown as Request
  const res = new EventEmitter() as unknown as Response & EventEmitter
  ;(res as unknown as { statusCode: number }).statusCode = 200
  return { req, res }
}

test('records the matched route pattern with id params collapsed', () => {
  const { req, res } = fakeReqRes({ method: 'GET', baseUrl: '/api/leads', routePath: '/:id' })
  metricsMiddleware(req, res, (() => {}) as NextFunction)
  assert.match(renderMetrics(), /http_requests_in_flight 1/) // counted on entry
  ;(res as unknown as { statusCode: number }).statusCode = 200
  ;(res as unknown as EventEmitter).emit('finish')

  const out = renderMetrics()
  assert.match(out, /http_requests_total\{method="GET",route="\/api\/leads\/:id",status="200"\} 1/)
  assert.match(out, /http_requests_in_flight 0/) // released on finish
  assert.match(out, /http_request_duration_seconds_count\{method="GET",route="\/api\/leads\/:id"\} 1/)
})

test('an unmatched route is labelled distinctly, not as a raw path', () => {
  const { req, res } = fakeReqRes({ method: 'POST', baseUrl: '' }) // no route matched
  ;(res as unknown as { statusCode: number }).statusCode = 404
  metricsMiddleware(req, res, (() => {}) as NextFunction)
  ;(res as unknown as EventEmitter).emit('finish')
  assert.match(renderMetrics(), /route="\/<unmatched>",status="404"/)
})

test('finish then close does not double-count or push in-flight negative', () => {
  const { req, res } = fakeReqRes({ method: 'GET', baseUrl: '/api/x', routePath: '/' })
  metricsMiddleware(req, res, (() => {}) as NextFunction)
  ;(res as unknown as EventEmitter).emit('finish')
  ;(res as unknown as EventEmitter).emit('close') // must be a no-op the second time
  const out = renderMetrics()
  assert.match(out, /http_requests_total\{method="GET",route="\/api\/x\/",status="200"\} 1/)
  assert.match(out, /http_requests_in_flight 0/)
})
