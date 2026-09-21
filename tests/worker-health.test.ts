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

test('GET /ready returns 503 when isReady rejects (degrades safely, does not throw)', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/ready`)
    assert.equal(res.status, 503)
    const body = await res.json()
    assert.equal(body.ready, false)
    assert.equal(body.ok, false)
  }, { isReady: () => Promise.reject(new Error('boom')) })
})

test('GET /metrics with no token configured, not production: served unauthenticated', async () => {
  const prior = process.env.METRICS_TOKEN
  const priorEnv = process.env.NODE_ENV
  delete process.env.METRICS_TOKEN
  process.env.NODE_ENV = 'test'
  try {
    await withServer(async (base) => {
      const res = await fetch(`${base}/metrics`)
      assert.equal(res.status, 200)
      assert.match(res.headers.get('content-type') ?? '', /text\/plain/)
    })
  } finally {
    if (prior !== undefined) process.env.METRICS_TOKEN = prior
    if (priorEnv !== undefined) process.env.NODE_ENV = priorEnv
  }
})

test('GET /metrics with no token configured, in production: 404 (never expose unauthenticated, and never probeable via 401)', async () => {
  const prior = process.env.METRICS_TOKEN
  const priorEnv = process.env.NODE_ENV
  delete process.env.METRICS_TOKEN
  process.env.NODE_ENV = 'production'
  try {
    await withServer(async (base) => {
      const res = await fetch(`${base}/metrics`)
      assert.equal(res.status, 404)
    })
  } finally {
    if (prior !== undefined) process.env.METRICS_TOKEN = prior
    else delete process.env.METRICS_TOKEN
    if (priorEnv !== undefined) process.env.NODE_ENV = priorEnv
    else delete process.env.NODE_ENV
  }
})

test('GET /metrics with a token configured: wrong bearer is rejected with 401', async () => {
  const prior = process.env.METRICS_TOKEN
  process.env.METRICS_TOKEN = 'correct-token'
  try {
    await withServer(async (base) => {
      const res = await fetch(`${base}/metrics`, { headers: { Authorization: 'Bearer wrong-token' } })
      assert.equal(res.status, 401)
    })
  } finally {
    if (prior !== undefined) process.env.METRICS_TOKEN = prior
    else delete process.env.METRICS_TOKEN
  }
})

test('GET /metrics with a token configured: the correct bearer is accepted and renders queue/domain metrics', async () => {
  const prior = process.env.METRICS_TOKEN
  process.env.METRICS_TOKEN = 'correct-token'
  try {
    await withServer(async (base) => {
      const res = await fetch(`${base}/metrics`, { headers: { Authorization: 'Bearer correct-token' } })
      assert.equal(res.status, 200)
      const body = await res.text()
      assert.ok(body.length > 0)
    }, {
      collectQueueDepths: async () => [],
      collectDomainMetrics: async () => ({}),
    })
  } finally {
    if (prior !== undefined) process.env.METRICS_TOKEN = prior
    else delete process.env.METRICS_TOKEN
  }
})

test('GET /metrics: a rejected collectQueueDepths/collectDomainMetrics degrades to empty rather than failing the scrape', async () => {
  const prior = process.env.METRICS_TOKEN
  delete process.env.METRICS_TOKEN
  const priorEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'test'
  try {
    await withServer(async (base) => {
      const res = await fetch(`${base}/metrics`)
      assert.equal(res.status, 200)
    }, {
      collectQueueDepths: () => Promise.reject(new Error('redis down')),
      collectDomainMetrics: () => Promise.reject(new Error('db down')),
    })
  } finally {
    if (prior !== undefined) process.env.METRICS_TOKEN = prior
    if (priorEnv !== undefined) process.env.NODE_ENV = priorEnv
  }
})
