// Pure-logic tests for the dependency liveness probes behind /api/ready and
// /api/health. No real DB/Redis: the DB probe runs against an installed fake
// Prisma, and the Redis probe takes an injected client.

import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { pingDatabase, pingRedis, withTimeout } from '../apps/api/src/lib/health.ts'
import { installPrisma, resetPrisma } from './helpers/integration.ts'

afterEach(() => resetPrisma())

test('pingDatabase returns true when the round-trip succeeds', async () => {
  installPrisma({ $queryRaw: async () => [{ '?column?': 1 }] } as never)
  assert.equal(await pingDatabase(), true)
})

test('pingDatabase returns false (never throws) when the query fails', async () => {
  installPrisma({ $queryRaw: async () => { throw new Error('connection refused') } } as never)
  assert.equal(await pingDatabase(), false)
})

test('pingDatabase returns false when the query hangs past the timeout', async () => {
  installPrisma({ $queryRaw: () => new Promise(() => {}) } as never)
  assert.equal(await pingDatabase(20), false)
})

const fakeRedis = (status: string, ping: () => Promise<string>) => ({ status, ping })

test('pingRedis returns true when connected and PING replies PONG', async () => {
  assert.equal(await pingRedis(fakeRedis('ready', async () => 'PONG')), true)
})

test('pingRedis returns false when the client is not connected (no PING issued)', async () => {
  let pinged = false
  const ok = await pingRedis(fakeRedis('connecting', async () => { pinged = true; return 'PONG' }))
  assert.equal(ok, false)
  assert.equal(pinged, false, 'must not PING a non-ready client')
})

test('pingRedis returns false when PING rejects', async () => {
  assert.equal(await pingRedis(fakeRedis('ready', async () => { throw new Error('down') })), false)
})

test('pingRedis returns false on an unexpected PING reply', async () => {
  assert.equal(await pingRedis(fakeRedis('ready', async () => 'WEIRD')), false)
})

test('pingRedis returns false when PING hangs past the timeout', async () => {
  assert.equal(await pingRedis(fakeRedis('ready', () => new Promise<string>(() => {})), 20), false)
})

test('withTimeout resolves with the value when the promise settles in time', async () => {
  assert.equal(await withTimeout(Promise.resolve(42), 1000), 42)
})

test('withTimeout rejects when the promise exceeds the budget', async () => {
  await assert.rejects(() => withTimeout(new Promise(() => {}), 20), /probe timeout/)
})
