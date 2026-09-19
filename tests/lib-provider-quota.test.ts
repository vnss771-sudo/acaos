// Unit tests for the platform-wide (cross-workspace) discovery-provider quota.

import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkProviderQuota,
  attachProviderQuotaStore,
  _resetProviderQuotaForTest,
  type RedisLike,
} from '../packages/backend-core/src/lib/providerQuota.ts'

const SAVED = { ...process.env }
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k]
  Object.assign(process.env, SAVED)
  attachProviderQuotaStore(undefined)
  _resetProviderQuotaForTest()
})

test('in-process fallback: allows calls up to the configured max, then throws 429', async () => {
  process.env.PROVIDER_QUOTA_TESTPROV_PER_HOUR = '2'
  await checkProviderQuota('testprov')
  await checkProviderQuota('testprov')
  await assert.rejects(
    () => checkProviderQuota('testprov'),
    (err: any) => {
      assert.equal(err.statusCode, 429)
      assert.match(err.message, /Platform-wide hourly quota for testprov reached \(2 calls\/hour/)
      return true
    },
  )
})

test('a provider with no configured default and no env var is unlimited', async () => {
  await checkProviderQuota('some_unlisted_provider')
  await checkProviderQuota('some_unlisted_provider')
  await checkProviderQuota('some_unlisted_provider')
  // No throw — nothing to assert beyond "it didn't reject".
})

test('PROVIDER_QUOTA_<PROVIDER>_PER_HOUR=0 disables the check for that provider', async () => {
  process.env.PROVIDER_QUOTA_APOLLO_PER_HOUR = '0'
  for (let i = 0; i < 5; i++) await checkProviderQuota('apollo')
})

test('RATE_LIMIT_DISABLED=true bypasses every provider check', async () => {
  process.env.RATE_LIMIT_DISABLED = 'true'
  process.env.PROVIDER_QUOTA_APOLLO_PER_HOUR = '1'
  await checkProviderQuota('apollo')
  await checkProviderQuota('apollo')
  await checkProviderQuota('apollo')
})

test('counters are tracked independently per provider', async () => {
  process.env.PROVIDER_QUOTA_APOLLO_PER_HOUR = '1'
  process.env.PROVIDER_QUOTA_GOOGLE_PLACES_PER_HOUR = '1'
  await checkProviderQuota('apollo')
  await checkProviderQuota('google_places') // separate counter — must not be blocked by apollo's
  await assert.rejects(() => checkProviderQuota('apollo'), (err: any) => err.statusCode === 429)
})

function fakeRedis(): RedisLike & { calls: string[] } {
  const counters = new Map<string, number>()
  return {
    calls: [] as string[],
    async incr(key: string) {
      this.calls.push(`incr:${key}`)
      const next = (counters.get(key) ?? 0) + 1
      counters.set(key, next)
      return next
    },
    async expire(key: string, seconds: number) {
      this.calls.push(`expire:${key}:${seconds}`)
      return 1
    },
  }
}

test('attached store: increments and expires through the shared client', async () => {
  process.env.PROVIDER_QUOTA_APOLLO_PER_HOUR = '2'
  const redis = fakeRedis()
  attachProviderQuotaStore(redis)

  await checkProviderQuota('apollo')
  await checkProviderQuota('apollo')
  await assert.rejects(() => checkProviderQuota('apollo'), (err: any) => err.statusCode === 429)

  assert.ok(redis.calls.some((c) => c.startsWith('incr:provq:apollo:')))
  assert.ok(redis.calls.some((c) => c.startsWith('expire:provq:apollo:')))
  // expire is only called on the FIRST increment in the window, not every call.
  assert.equal(redis.calls.filter((c) => c.startsWith('expire:')).length, 1)
})

test('fail-open: a store error falls back to in-process enforcement rather than blocking the call', async () => {
  process.env.PROVIDER_QUOTA_APOLLO_PER_HOUR = '1'
  attachProviderQuotaStore({
    async incr() { throw new Error('redis down') },
    async expire() { throw new Error('redis down') },
  })

  // Falls back to the in-process counter instead of throwing on the Redis error.
  await checkProviderQuota('apollo')
  await assert.rejects(() => checkProviderQuota('apollo'), (err: any) => err.statusCode === 429)
})
