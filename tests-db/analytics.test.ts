// Database-backed test for the product-analytics event stream + activation funnel:
// trackEvent persists rows, and getActivationFunnel counts DISTINCT workspaces per
// stage (a workspace counts once no matter how many times it emits a stage event).

import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { trackEvent, getActivationFunnel } from '../packages/backend-core/src/lib/analytics.ts'
import { prisma, resetDb, disconnect } from './helpers/db.ts'

after(async () => { await disconnect() })
beforeEach(async () => { await resetDb() })

test('trackEvent persists an event row with name, ids, and properties', async () => {
  await trackEvent({ name: 'signup', workspaceId: 'w1', userId: 'u1', properties: { plan: 'free' } })
  const rows = await prisma.analyticsEvent.findMany({ where: { name: 'signup' } })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].workspaceId, 'w1')
  assert.equal(rows[0].userId, 'u1')
  assert.deepEqual(rows[0].properties, { plan: 'free' })
})

test('getActivationFunnel counts distinct workspaces per stage, with conversion', async () => {
  // 3 workspaces sign up; 2 configure ICP; 1 sends; 0 reply. wA emits signup twice
  // (must still count once).
  await trackEvent({ name: 'signup', workspaceId: 'wA' })
  await trackEvent({ name: 'signup', workspaceId: 'wA' }) // duplicate — distinct count = 1
  await trackEvent({ name: 'signup', workspaceId: 'wB' })
  await trackEvent({ name: 'signup', workspaceId: 'wC' })
  await trackEvent({ name: 'icp.configured', workspaceId: 'wA' })
  await trackEvent({ name: 'icp.configured', workspaceId: 'wB' })
  await trackEvent({ name: 'campaign.sent', workspaceId: 'wA' })

  const funnel = await getActivationFunnel()
  const byKey = Object.fromEntries(funnel.map((s) => [s.key, s]))
  assert.equal(byKey['signup'].count, 3)
  assert.equal(byKey['icp.configured'].count, 2)
  assert.equal(byKey['campaign.sent'].count, 1)
  assert.equal(byKey['reply.received'].count, 0)
  assert.equal(byKey['icp.configured'].conversionFromTop, 0.67) // 2/3
  assert.equal(byKey['campaign.sent'].conversionFromPrev, 0.5)  // 1/2
})
