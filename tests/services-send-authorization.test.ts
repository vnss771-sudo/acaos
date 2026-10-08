import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { authorizeOutboundSend } from '../packages/backend-core/src/services/sendAuthorization.ts'
import { createFakePrisma, installPrisma, resetPrisma } from './helpers/integration.ts'

const WS = 'send-auth-workspace'
const savedMode = process.env.REPUTATION_GUARD_MODE

afterEach(() => {
  resetPrisma()
  if (savedMode === undefined) delete process.env.REPUTATION_GUARD_MODE
  else process.env.REPUTATION_GUARD_MODE = savedMode
})

// Workspace exists and is not suppressed, but the reputation ledger is unreadable.
function installUnreadableLedger() {
  const fail = async () => { throw new Error('ledger unavailable') }
  const db = createFakePrisma({
    workspace: { findUnique: async () => ({ sendSuppressed: false, lawfulBasis: null, targetsCanada: false }) },
    contactEvent: { count: fail },
    unsubscribeEvent: { count: fail },
    auditEvent: { create: async () => ({}) },
  })
  installPrisma(db)
  return db
}

test('enforce mode denies with REPUTATION_UNAVAILABLE when the reputation ledger cannot be read', async () => {
  process.env.REPUTATION_GUARD_MODE = 'enforce'
  const db = installUnreadableLedger()
  const decision = await authorizeOutboundSend({ workspaceId: WS, context: 'campaign', recipientChecks: false })
  assert.equal(decision.allowed, false)
  assert.equal(decision.code, 'REPUTATION_UNAVAILABLE')
  const audit = db.callsTo('auditEvent', 'create')
  assert.equal(audit.length, 1)
  assert.equal((audit[0].args[0] as any).data.type, 'send.authorization.denied')
})

test('observe mode allows but records REPUTATION_UNAVAILABLE as an observation', async () => {
  process.env.REPUTATION_GUARD_MODE = 'observe'
  installUnreadableLedger()
  const decision = await authorizeOutboundSend({ workspaceId: WS, context: 'campaign', recipientChecks: false })
  assert.equal(decision.allowed, true)
  assert.deepEqual(decision.observations, ['REPUTATION_UNAVAILABLE'])
})
