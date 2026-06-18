// Integration tests for the requestContext middleware. It assigns each request
// a correlation id (honoring an inbound X-Request-Id), echoes it on the
// response, and attaches a child logger — the backbone of request tracing. We
// drive it through a real Express server so the header round-trip and the
// status-keyed access log (which runs on res 'finish') are exercised, including
// the 4xx/5xx branches that pick the log level.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Router } from 'express'
import { requestContext } from '../apps/api/src/middleware/requestContext.ts'
import { startTestServer, type TestServer } from './helpers/integration.ts'

let server: TestServer

before(async () => {
  const router = Router()
  router.get('/ok', (_req, res) => { res.json({ ok: true }) })
  router.get('/bad', (_req, res) => { res.status(400).json({ error: 'bad' }) })
  router.get('/boom', (_req, res) => { res.status(500).json({ error: 'boom' }) })
  // Echo what the middleware attached so we can assert req.id is populated.
  router.get('/echo', (req, res) => { res.json({ id: req.id, hasLog: typeof req.log?.info === 'function' }) })

  server = await startTestServer('/t', router, { configure: (app) => app.use(requestContext) })
})
after(async () => { await server.close() })

test('generates a correlation id and echoes it on the X-Request-Id header', async () => {
  const res = await server.request('/t/ok')
  assert.equal(res.status, 200)
  const id = res.headers.get('x-request-id')
  assert.ok(id && id.length >= 8, 'a request id should be generated')
})

test('honors an inbound X-Request-Id and reflects it back unchanged', async () => {
  const res = await server.request('/t/ok', { headers: { 'X-Request-Id': 'trace-abc-123' } })
  assert.equal(res.headers.get('x-request-id'), 'trace-abc-123')
})

test('a blank inbound X-Request-Id is replaced with a generated id', async () => {
  const res = await server.request('/t/ok', { headers: { 'X-Request-Id': '   ' } })
  const id = res.headers.get('x-request-id')
  assert.ok(id && id.trim().length > 0)
  assert.notEqual(id, '   ')
})

test('attaches a per-request id and child logger to the request object', async () => {
  const res = await server.request('/t/echo')
  assert.ok(res.body.id && res.body.id.length > 0)
  assert.equal(res.body.hasLog, true)
})

test('completes cleanly across 2xx/4xx/5xx (each picks its own log level)', async () => {
  // The access log runs on res 'finish' and selects info/warn/error by status;
  // these requests must all return their status without the logging throwing.
  assert.equal((await server.request('/t/ok')).status, 200)
  assert.equal((await server.request('/t/bad')).status, 400)
  assert.equal((await server.request('/t/boom')).status, 500)
})

test('issues a distinct correlation id per request when none is supplied', async () => {
  const a = (await server.request('/t/ok')).headers.get('x-request-id')
  const b = (await server.request('/t/ok')).headers.get('x-request-id')
  assert.notEqual(a, b)
})
