// Launch regression: Australian policy is enforced before the campaign batch
// fast path and is shared by campaign and follow-up dispatch.
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { authorizeOutboundSend } from '../packages/backend-core/src/services/sendAuthorization.ts'
import { createFakePrisma, installPrisma, resetPrisma } from './helpers/integration.ts'

const original = Object.fromEntries([
  'REPUTATION_GUARD_MODE', 'FEATURE_SEND',
  'AU_COMMERCIAL_SENDING_ENABLED', 'AU_JURISDICTION_REVIEW_REQUIRED',
].map(k => [k, process.env[k]]))

afterEach(() => {
  resetPrisma()
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function workspace(targetsAustralia: boolean) {
  const db = createFakePrisma({
    workspace: { findUnique: async () => ({
      sendSuppressed: false,
      lawfulBasis: null,
      targetsCanada: false,
      targetsAustralia,
    }) },
    auditEvent: { create: async () => ({}) },
  })
  installPrisma(db)
  process.env.FEATURE_SEND = 'true'
  process.env.REPUTATION_GUARD_MODE = 'off'
  return db
}

for (const context of ['campaign', 'followup'] as const) {
  test(`${context}: Australian workspace stays blocked even with recipientChecks=false`, async () => {
    const db = workspace(true)
    process.env.AU_COMMERCIAL_SENDING_ENABLED = 'false'
    process.env.AU_JURISDICTION_REVIEW_REQUIRED = 'false'
    const result = await authorizeOutboundSend({ workspaceId: 'au-ws', context, recipientChecks: false })
    assert.equal(result.allowed, false)
    assert.equal(result.code, 'AU_SENDING_DISABLED')
    const audit = db.callsTo('auditEvent', 'create')
    assert.equal(audit.length, 1)
    assert.equal((audit[0].args[0] as any).data.type, 'send.authorization.denied')
  })

  test(`${context}: unclassified workspace is held for jurisdiction review at batch start`, async () => {
    workspace(false)
    process.env.AU_COMMERCIAL_SENDING_ENABLED = 'false'
    process.env.AU_JURISDICTION_REVIEW_REQUIRED = 'true'
    const result = await authorizeOutboundSend({ workspaceId: 'unknown-ws', context, recipientChecks: false })
    assert.equal(result.allowed, false)
    assert.equal(result.code, 'AU_JURISDICTION_REVIEW_REQUIRED')
  })
}

test('Australian sending enabled still requires recipient checks at individual dispatch', async () => {
  workspace(true)
  process.env.AU_COMMERCIAL_SENDING_ENABLED = 'true'
  process.env.AU_JURISDICTION_REVIEW_REQUIRED = 'true'
  const result = await authorizeOutboundSend({ workspaceId: 'au-ws', context: 'campaign' })
  assert.equal(result.allowed, false)
  assert.equal(result.code, 'RECIPIENT_REQUIRED')
})

test('reply is exempt from the Australian commercial-outreach pause at batch gate', async () => {
  workspace(true)
  process.env.AU_COMMERCIAL_SENDING_ENABLED = 'false'
  process.env.AU_JURISDICTION_REVIEW_REQUIRED = 'true'
  const result = await authorizeOutboundSend({ workspaceId: 'au-ws', context: 'reply', recipientChecks: false })
  assert.equal(result.allowed, true)
  assert.equal(result.code, 'ALLOWED')
})
