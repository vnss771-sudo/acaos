import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { legalRouter } from '../apps/api/src/routes/legal.ts'
import { SUBPROCESSORS_VERSION, COMPLIANCE_TERMS_VERSION } from '../packages/backend-core/src/lib/subprocessors.ts'
import { startTestServer, type TestServer } from './helpers/integration.ts'

let server: TestServer
before(async () => { server = await startTestServer('/api/legal', legalRouter) })
after(async () => { await server.close() })

test('GET /subprocessors is public and returns the versioned disclosure', async () => {
  const res = await server.request('/api/legal/subprocessors')
  assert.equal(res.status, 200)
  assert.equal(res.body.version, SUBPROCESSORS_VERSION)
  assert.ok(Array.isArray(res.body.subprocessors) && res.body.subprocessors.length > 0)
  assert.ok(res.body.subprocessors.some((s: { name: string }) => s.name === 'OpenAI'))
})

test('GET /terms returns the current terms version (no auth required)', async () => {
  const res = await server.request('/api/legal/terms')
  assert.equal(res.status, 200)
  assert.equal(res.body.termsVersion, COMPLIANCE_TERMS_VERSION)
})
