import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildWebhookEnvelope, generateWebhookSecret, signWebhookBody, webhookSignatureHeader,
  verifyWebhookSignature, nextRetryDelaySeconds, deliverWebhook, recordDeliveryOutcome,
  emitWebhookEvent, isWebhookEventType, WEBHOOK_FAILURE_DISABLE_THRESHOLD,
} from '../packages/backend-core/src/lib/webhooks.ts'
import { createFakePrisma, installPrisma, resetPrisma } from './helpers/integration.ts'

afterEach(() => resetPrisma())

test('signWebhookBody is deterministic and binds the timestamp + body', () => {
  const sig = signWebhookBody('whsec_x', 1000, '{"a":1}')
  assert.equal(sig, signWebhookBody('whsec_x', 1000, '{"a":1}')) // deterministic
  assert.notEqual(sig, signWebhookBody('whsec_x', 1001, '{"a":1}')) // ts is signed
  assert.notEqual(sig, signWebhookBody('whsec_x', 1000, '{"a":2}')) // body is signed
  assert.notEqual(sig, signWebhookBody('whsec_y', 1000, '{"a":1}')) // secret matters
})

test('verifyWebhookSignature round-trips and rejects tampering / stale timestamps', () => {
  const secret = generateWebhookSecret()
  const body = JSON.stringify({ hello: 'world' })
  const header = webhookSignatureHeader(secret, 1000, body)
  assert.equal(verifyWebhookSignature(secret, header, body, 1000), true)
  assert.equal(verifyWebhookSignature(secret, header, body, 1200), true)   // within tolerance
  assert.equal(verifyWebhookSignature(secret, header, body, 9999), false)  // stale (>300s)
  assert.equal(verifyWebhookSignature(secret, header, body + 'x', 1000), false) // tampered body
  assert.equal(verifyWebhookSignature('whsec_other', header, body, 1000), false) // wrong secret
})

test('nextRetryDelaySeconds backs off exponentially and caps at one hour', () => {
  assert.equal(nextRetryDelaySeconds(0), 30)
  assert.equal(nextRetryDelaySeconds(1), 60)
  assert.equal(nextRetryDelaySeconds(2), 120)
  assert.equal(nextRetryDelaySeconds(100), 3600) // capped
})

test('isWebhookEventType validates the closed set', () => {
  assert.equal(isWebhookEventType('reply.received'), true)
  assert.equal(isWebhookEventType('nope'), false)
})

test('deliverWebhook signs the request and reports success/failure, never throws', async () => {
  let captured: { url: string; headers: Record<string, string>; body: string } | undefined
  const fakeFetch = (async (url: string, init: any) => {
    captured = { url, headers: init.headers, body: init.body }
    return { status: 204 } as Response
  }) as unknown as typeof fetch

  const envelope = buildWebhookEnvelope('reply.received', { leadId: 'l1' }, 'evt_1', new Date('2026-06-25T00:00:00Z'))
  const res = await deliverWebhook({ url: 'https://hook.test/x', secret: 'whsec_s' }, envelope, { fetch: fakeFetch, now: () => 1000_000 })
  assert.equal(res.ok, true)
  assert.equal(res.status, 204)
  assert.equal(captured?.headers['Acaos-Event'], 'reply.received')
  // The signature header verifies against the exact body that was sent.
  assert.equal(verifyWebhookSignature('whsec_s', captured!.headers['Acaos-Signature'], captured!.body, 1000), true)

  // A throwing transport (network error) is swallowed → ok:false, status:null.
  const boom = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
  const failed = await deliverWebhook({ url: 'https://x', secret: 's' }, envelope, { fetch: boom })
  assert.deepEqual(failed, { ok: false, status: null })

  // A 5xx is a non-2xx failure (status preserved).
  const five = (async () => ({ status: 500 } as Response)) as unknown as typeof fetch
  assert.deepEqual(await deliverWebhook({ url: 'https://x', secret: 's' }, envelope, { fetch: five }), { ok: false, status: 500 })
})

test('recordDeliveryOutcome resets on success, increments on failure, auto-disables past the threshold', async () => {
  let updateArg: any
  installPrisma(createFakePrisma({ webhookEndpoint: { update: async (a: any) => { updateArg = a; return {} } } }))

  await recordDeliveryOutcome((await import('../packages/backend-core/src/lib/prisma.ts')).prisma as any, 'e1', { ok: true, status: 200 }, 5)
  assert.equal(updateArg.data.failureCount, 0)
  assert.equal(updateArg.data.enabled, undefined) // not disabled on success

  await recordDeliveryOutcome((await import('../packages/backend-core/src/lib/prisma.ts')).prisma as any, 'e1', { ok: false, status: 500 }, WEBHOOK_FAILURE_DISABLE_THRESHOLD - 1)
  assert.equal(updateArg.data.failureCount, WEBHOOK_FAILURE_DISABLE_THRESHOLD)
  assert.equal(updateArg.data.enabled, false) // auto-disabled at the threshold
})

test('emitWebhookEvent delivers only to enabled endpoints subscribed to the event', async () => {
  const delivered: string[] = []
  const fakeFetch = (async (url: string) => { delivered.push(url); return { status: 200 } as Response }) as unknown as typeof fetch
  installPrisma(createFakePrisma({
    webhookEndpoint: {
      // The route is responsible for the where-filter; the fake honors it by returning
      // only the matching endpoints (enabled + subscribed), mirroring the query.
      findMany: async (a: any) => {
        assert.equal(a.where.enabled, true)
        assert.deepEqual(a.where.eventTypes, { has: 'reply.received' })
        return [{ id: 'e1', url: 'https://a.test', secret: 's', failureCount: 0 }]
      },
      update: async () => ({}),
    },
  }))
  await emitWebhookEvent('w1', 'reply.received', { leadId: 'l1' }, undefined, { fetch: fakeFetch })
  assert.deepEqual(delivered, ['https://a.test'])
})
