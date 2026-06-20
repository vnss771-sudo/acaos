import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { startHealthServer } from '../apps/worker/src/health.ts'

async function withServer(
  fn: (base: string) => Promise<void>,
  opts: Parameters<typeof startHealthServer>[1] = {},
) {
  const server = startHealthServer(0, opts)
  await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())))
  const { port } = server.address() as AddressInfo
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
  }
}

test('GET /health returns 200 with release metadata and header', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/health`)
    assert.equal(res.status, 200)
    assert.ok(res.headers.get('x-acaos-release-id'))
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.service, 'acaos-worker')
    assert.ok(body.releaseId)
  })
})

test('GET /live returns 200', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/live`)).status, 200)
  })
})

test('GET /ready returns 200 when ready', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/ready`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ready, true)
  }, { isReady: () => true })
})

test('GET /ready returns 503 when not ready', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/ready`)
    assert.equal(res.status, 503)
    const body = await res.json()
    assert.equal(body.ready, false)
  }, { isReady: () => false })
})

test('unknown paths return 404', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/anything-else`)).status, 404)
  })
})
