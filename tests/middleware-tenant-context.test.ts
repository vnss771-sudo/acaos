import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import type { Request, Response } from 'express'
import { tenantContext } from '../apps/api/src/middleware/tenantContext.ts'
import { currentWorkspaceId } from '../packages/backend-core/src/lib/tenantContext.ts'

const saved = process.env.TENANT_GUARD_MODE
afterEach(() => { if (saved === undefined) delete process.env.TENANT_GUARD_MODE; else process.env.TENANT_GUARD_MODE = saved })

// Run the middleware and report the workspace context observed inside next().
function observedContext(req: Partial<Request>, mode: string): string | undefined {
  process.env.TENANT_GUARD_MODE = mode
  let seen: string | undefined
  tenantContext(req as Request, {} as Response, () => { seen = currentWorkspaceId() })
  return seen
}

test('establishes the tenant context from ?workspaceId when the guard is active', () => {
  assert.equal(observedContext({ query: { workspaceId: 'ws1' } }, 'observe'), 'ws1')
})

test('establishes the context from a POST body workspaceId', () => {
  assert.equal(observedContext({ query: {}, body: { workspaceId: 'ws2' } }, 'enforce'), 'ws2')
})

test('is a strict no-op when the guard is off (default) — no context set, zero hot-path cost', () => {
  assert.equal(observedContext({ query: { workspaceId: 'ws1' } }, 'off'), undefined)
})

test('sets no context when the request carries no workspaceId (resource-id routes fall through)', () => {
  assert.equal(observedContext({ query: {}, body: {} }, 'observe'), undefined)
})

test('ignores a non-string workspaceId (array/object from untrusted query)', () => {
  assert.equal(observedContext({ query: { workspaceId: ['a', 'b'] as unknown as string }, body: {} }, 'observe'), undefined)
})
