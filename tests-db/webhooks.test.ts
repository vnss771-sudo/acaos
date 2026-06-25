// Database-backed test for outbound-webhook emission: the `eventTypes: { has }`
// Postgres array filter selects only subscribed+enabled endpoints, deliveries are
// signed and POSTed (via an injected fetch), and delivery health is persisted
// (failureCount reset/increment + auto-disable).

import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { emitWebhookEvent, generateWebhookSecret, verifyWebhookSignature, WEBHOOK_FAILURE_DISABLE_THRESHOLD } from '../packages/backend-core/src/lib/webhooks.ts'
import { prisma, resetDb, disconnect, seedUserWithWorkspace } from './helpers/db.ts'

after(async () => { await disconnect() })
beforeEach(async () => { await resetDb() })

test('emitWebhookEvent delivers only to subscribed + enabled endpoints and records success', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const ws = workspace.id
  const subscribed = await prisma.webhookEndpoint.create({ data: { workspaceId: ws, url: 'https://sub.test', secret: generateWebhookSecret(), eventTypes: ['reply.received'], enabled: true } })
  // Not subscribed to reply.received:
  await prisma.webhookEndpoint.create({ data: { workspaceId: ws, url: 'https://other.test', secret: generateWebhookSecret(), eventTypes: ['campaign.sent'], enabled: true } })
  // Subscribed but disabled:
  await prisma.webhookEndpoint.create({ data: { workspaceId: ws, url: 'https://off.test', secret: generateWebhookSecret(), eventTypes: ['reply.received'], enabled: false } })

  const hits: Array<{ url: string; headers: Record<string, string>; body: string }> = []
  const fakeFetch = (async (url: string, init: any) => { hits.push({ url, headers: init.headers, body: init.body }); return { status: 200 } as Response }) as unknown as typeof fetch

  await emitWebhookEvent(ws, 'reply.received', { leadId: 'l1' }, prisma, { fetch: fakeFetch })

  assert.deepEqual(hits.map((h) => h.url), ['https://sub.test'], 'only the subscribed, enabled endpoint received it')
  // The delivery is verifiably signed with that endpoint's secret.
  const h = hits[0]
  assert.equal(verifyWebhookSignature(subscribed.secret, h.headers['Acaos-Signature'], h.body, Math.floor(Date.now() / 1000)), true)
  const after = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: subscribed.id } })
  assert.equal(after.lastStatus, 200)
  assert.equal(after.failureCount, 0)
})

test('a failing delivery increments failureCount and auto-disables at the threshold', async () => {
  const { workspace } = await seedUserWithWorkspace()
  const ep = await prisma.webhookEndpoint.create({
    data: { workspaceId: workspace.id, url: 'https://dead.test', secret: generateWebhookSecret(), eventTypes: ['reply.received'], enabled: true, failureCount: WEBHOOK_FAILURE_DISABLE_THRESHOLD - 1 },
  })
  const fail = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
  await emitWebhookEvent(workspace.id, 'reply.received', { leadId: 'l1' }, prisma, { fetch: fail })

  const after = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ep.id } })
  assert.equal(after.failureCount, WEBHOOK_FAILURE_DISABLE_THRESHOLD)
  assert.equal(after.enabled, false, 'chronically-failing endpoint auto-disabled')
})
