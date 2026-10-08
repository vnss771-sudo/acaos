import { test, expect } from '@playwright/test'
import {
  createApiAccount, closeDb, seedRepliedThread, suppressWorkspace,
  suppressRecipient, degradeSenderReputation, seedUnsafeMailboxConfig,
} from './helpers.js'

test.afterAll(closeDb)

function auth(token: string) { return { Authorization: `Bearer ${token}` } }

// UQ-06: high-impact negative journeys. These hit the real API + real Postgres
// through Playwright's request context; no external provider is contacted.

test('workspace suppression blocks a human reply before mailbox/provider dispatch', async ({ request }) => {
  const a = await createApiAccount(request)
  const replyId = await seedRepliedThread(a.workspaceId)
  await suppressWorkspace(a.workspaceId)

  const res = await request.post(`/api/inbox/reply/${replyId}/send`, {
    headers: auth(a.token),
    data: { workspaceId: a.workspaceId, body: 'Thanks for the reply.', idempotencyKey: `e2e_${Date.now()}` },
  })
  expect(res.status()).toBe(403)
  expect(await res.text()).toContain('Sending is suspended for this workspace')
})

test('recipient unsubscribe blocks a human reply before mailbox/provider dispatch', async ({ request }) => {
  const a = await createApiAccount(request)
  const recipient = 'unsubscribed@example.com'
  const replyId = await seedRepliedThread(a.workspaceId, recipient)
  await suppressRecipient(a.workspaceId, recipient)

  const res = await request.post(`/api/inbox/reply/${replyId}/send`, {
    headers: auth(a.token),
    data: { workspaceId: a.workspaceId, body: 'This must not send.', idempotencyKey: `e2e_${Date.now()}` },
  })
  expect(res.status()).toBe(409)
  expect(await res.text()).toContain('unsubscribed or is suppressed')
})

test('reputation enforcement blocks a human reply before mailbox/provider dispatch', async ({ request }) => {
  const a = await createApiAccount(request)
  const replyId = await seedRepliedThread(a.workspaceId)
  await degradeSenderReputation(a.workspaceId)

  const res = await request.post(`/api/inbox/reply/${replyId}/send`, {
    headers: auth(a.token),
    data: { workspaceId: a.workspaceId, body: 'This must be reputation-blocked.', idempotencyKey: `e2e_${Date.now()}` },
  })
  expect(res.status()).toBe(409)
  expect(await res.text()).toContain('sender reputation')
})

test('SAFE_LAUNCH requires explicit campaign approval even if workspace approvalMode is off', async ({ request }) => {
  const a = await createApiAccount(request)
  const headers = auth(a.token)

  const icp = await request.put(`/api/workspaces/${a.workspaceId}/icp`, {
    headers,
    data: { businessType: 'Electrical', targetIndustries: [], targetGeos: [], excludedIndustries: [], mustHaveEmail: false, outreachTone: 'professional', dailySendLimit: 50, approvalMode: false },
  })
  expect(icp.ok()).toBeTruthy()

  const camp = await request.post('/api/campaigns', { headers, data: { workspaceId: a.workspaceId, name: 'Safe launch negative', goalType: 'BOOK_CALL' } })
  expect(camp.ok()).toBeTruthy()
  const campaignId = (await camp.json()).campaign.id as string
  const imported = await request.post('/api/leads/import', {
    headers,
    data: { workspaceId: a.workspaceId, leads: [{ businessName: 'Target', email: 'target@example.com', campaignId }] },
  })
  expect(imported.ok()).toBeTruthy()

  const res = await request.post(`/api/campaigns/${campaignId}/send`, { headers, data: {} })
  expect(res.status()).toBe(403)
  expect(await res.text()).toContain('Approval required')
})


test('unsafe/unavailable workspace mail provider fails before any external dispatch', async ({ request }) => {
  const a = await createApiAccount(request)
  const replyId = await seedRepliedThread(a.workspaceId, 'provider-failure@example.com')
  await seedUnsafeMailboxConfig(a.workspaceId)

  const res = await request.post(`/api/inbox/reply/${replyId}/send`, {
    headers: auth(a.token),
    data: { workspaceId: a.workspaceId, body: 'Provider failure path.', idempotencyKey: `e2e_${Date.now()}` },
  })
  expect(res.status()).toBe(400)
  expect(await res.text()).toContain('private or reserved IP not permitted')
})

test('foreign tenant campaign ID is indistinguishable from a missing resource', async ({ request }) => {
  const a = await createApiAccount(request)
  const b = await createApiAccount(request)
  const created = await request.post('/api/campaigns', {
    headers: auth(b.token),
    data: { workspaceId: b.workspaceId, name: 'Blue secret campaign', goalType: 'BOOK_CALL' },
  })
  expect(created.ok()).toBeTruthy()
  const foreignId = (await created.json()).campaign.id as string

  const foreign = await request.post(`/api/campaigns/${foreignId}/send`, { headers: auth(a.token), data: { approved: true } })
  const missing = await request.post('/api/campaigns/cmissinge2eresource000000/send', { headers: auth(a.token), data: { approved: true } })
  expect(foreign.status()).toBe(404)
  expect(missing.status()).toBe(404)
  expect(await foreign.text()).toBe(await missing.text())
})

test('logout revokes the refresh session so it cannot be refreshed again', async ({ request }) => {
  const a = await createApiAccount(request)
  const logout = await request.post('/api/auth/logout', { headers: { ...auth(a.token), 'x-csrf-protection': '1' } })
  expect(logout.ok()).toBeTruthy()
  const refresh = await request.post('/api/auth/refresh', { headers: { 'x-csrf-protection': '1' } })
  expect(refresh.status()).toBe(401)
})
