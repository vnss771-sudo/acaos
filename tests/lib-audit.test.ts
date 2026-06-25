import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { recordAudit, recordCriticalAudit } from '../packages/backend-core/src/lib/audit.ts'
import { setErrorReporter } from '../packages/backend-core/src/lib/observability.ts'
import { createFakePrisma, installPrisma, resetPrisma } from './helpers/integration.ts'

afterEach(() => { resetPrisma(); setErrorReporter(null) })

test('recordCriticalAudit writes the event row on success', async () => {
  let created: Record<string, unknown> | undefined
  installPrisma(createFakePrisma({
    auditEvent: { create: async (a: any) => { created = a.data; return { id: 'a1', ...a.data } } },
  }))
  await recordCriticalAudit({ type: 'mfa.disable', actorUserId: 'u1', entityType: 'User', entityId: 'u1' })
  assert.equal(created?.type, 'mfa.disable')
  assert.equal(created?.entityId, 'u1')
})

test('recordCriticalAudit escalates a write failure to the error reporter and does NOT throw', async () => {
  const captured: Array<{ ctx?: Record<string, unknown> }> = []
  setErrorReporter((_err, ctx) => { captured.push({ ctx }) })
  installPrisma(createFakePrisma({
    auditEvent: { create: async () => { throw new Error('db down') } },
  }))

  // Must not throw — failing the security action on an audit blip would be worse.
  await assert.doesNotReject(() => recordCriticalAudit({ type: 'workspace.deleted', entityType: 'workspace', entityId: 'w1' }))
  // …but the failure is reported (paged), not silently swallowed.
  assert.equal(captured.length, 1)
  assert.equal(captured[0].ctx?.kind, 'critical-audit-failure')
  assert.equal(captured[0].ctx?.auditType, 'workspace.deleted')
  assert.equal(captured[0].ctx?.entityId, 'w1')
})

test('routine recordAudit swallows a write failure quietly (no error report, no throw)', async () => {
  const captured: unknown[] = []
  setErrorReporter((err) => { captured.push(err) })
  installPrisma(createFakePrisma({
    auditEvent: { create: async () => { throw new Error('db down') } },
  }))
  await assert.doesNotReject(() => recordAudit({ type: 'lead.updated', entityId: 'l1' }))
  assert.equal(captured.length, 0, 'routine audit failures are not escalated to the reporter')
})
