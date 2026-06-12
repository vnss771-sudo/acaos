// Tests for the worker liveness HTTP server (PROD-2).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { startHealthServer } from '../apps/worker/src/health.ts'

async function withServer(fn: (base: string) => Promise<void>) {
  const server = startHealthServer(0) // ephemeral port
  await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())))
  const { port } = server.address() as AddressInfo
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
  }
}

test('GET /health returns 200 with an ok body', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/health`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.service, 'acaos-worker')
  })
})

test('GET /live returns 200', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/live`)).status, 200)
  })
})

test('unknown paths return 404', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/anything-else`)).status, 404)
  })
})
