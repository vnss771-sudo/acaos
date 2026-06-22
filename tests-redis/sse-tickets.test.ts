// Redis-tier tests for the single-use SSE auth tickets. EventSource can't send an
// Authorization header, so the client exchanges its credentials for a short-lived
// ticket and opens the stream with ?ticket=. The security guarantees we pin here:
// a ticket is bound to one user, is redeemable exactly once (atomic GETDEL), and
// carries a TTL so a leaked-but-unused ticket self-expires.

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import IORedis from 'ioredis'
import { issueSseTicket, consumeSseTicket } from '../apps/api/src/lib/sseTickets.ts'
import { flushRedis } from './helpers/redis.ts'

const redis = new IORedis(process.env.REDIS_URL as string, { maxRetriesPerRequest: null })
after(async () => { await redis.quit() })
beforeEach(async () => { await flushRedis() })

test('issued ticket redeems once to the bound userId', async () => {
  const ticket = await issueSseTicket('user_1')
  assert.match(ticket, /^[0-9a-f]{64}$/, 'ticket is 32 random bytes hex-encoded')
  assert.equal(await consumeSseTicket(ticket), 'user_1')
})

test('a ticket is single-use: the second redemption returns null', async () => {
  const ticket = await issueSseTicket('user_2')
  assert.equal(await consumeSseTicket(ticket), 'user_2')
  assert.equal(await consumeSseTicket(ticket), null, 'ticket must not be replayable')
})

test('consuming an unknown or empty ticket returns null', async () => {
  assert.equal(await consumeSseTicket('does-not-exist'), null)
  assert.equal(await consumeSseTicket(''), null)
})

test('tickets are bound per user and are independent', async () => {
  const t1 = await issueSseTicket('user_a')
  const t2 = await issueSseTicket('user_b')
  assert.notEqual(t1, t2)
  // Redeeming one does not affect the other.
  assert.equal(await consumeSseTicket(t1), 'user_a')
  assert.equal(await consumeSseTicket(t2), 'user_b')
})

test('the ticket key carries a short TTL so an unused ticket self-expires', async () => {
  const ticket = await issueSseTicket('user_ttl')
  const ttl = await redis.ttl('sse:ticket:' + ticket)
  assert.ok(ttl > 0 && ttl <= 60, `expected a positive TTL <= 60s, got ${ttl}`)
})
