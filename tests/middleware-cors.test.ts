import test from 'node:test'
import assert from 'node:assert/strict'
import { Router } from 'express'
import { corsMiddleware, CORS_PREFLIGHT_MAX_AGE_SECONDS } from '../apps/api/src/middleware/cors.ts'
import { startTestServer, type TestServer } from './helpers/integration.ts'

const ALLOWED = 'https://app.acaos.test'

function preflight(server: TestServer, origin: string) {
  return fetch(`${server.baseUrl}/api/leads`, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type',
    },
  })
}

test('CORS preflights from the allowlist are cacheable', async (t) => {
  const savedEnv = process.env.NODE_ENV
  const savedOrigins = process.env.ALLOWED_ORIGINS
  // The allowlist branch is chosen when the middleware is built, so build it as production.
  process.env.NODE_ENV = 'production'
  process.env.ALLOWED_ORIGINS = ALLOWED
  const middleware = corsMiddleware()
  process.env.NODE_ENV = savedEnv
  const server = await startTestServer('/api', Router(), { configure: (app) => { app.use(middleware) } })
  t.after(async () => {
    await server.close()
    if (savedOrigins === undefined) delete process.env.ALLOWED_ORIGINS
    else process.env.ALLOWED_ORIGINS = savedOrigins
  })

  await t.test('an allowed origin gets the max age with its CORS answer', async () => {
    const res = await preflight(server, ALLOWED)
    assert.equal(res.status, 204)
    assert.equal(res.headers.get('access-control-allow-origin'), ALLOWED)
    assert.equal(res.headers.get('access-control-allow-credentials'), 'true')
    assert.equal(res.headers.get('access-control-max-age'), String(CORS_PREFLIGHT_MAX_AGE_SECONDS))
  })

  await t.test('any other origin gets no CORS answer to cache', async () => {
    const res = await preflight(server, 'https://evil.example')
    assert.equal(res.headers.get('access-control-allow-origin'), null)
    assert.equal(res.headers.get('access-control-max-age'), null)
  })
})
