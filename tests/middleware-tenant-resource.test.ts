import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import type { Request, Response, NextFunction } from 'express'
import { tenantResourceScope } from '../apps/api/src/middleware/tenantResource.ts'
import { currentWorkspaceId, runInWorkspaceContext } from '../packages/backend-core/src/lib/tenantContext.ts'
import { createFakePrisma, installPrisma, resetPrisma } from './helpers/integration.ts'

const USER = 'tenant-scope-user'
const WS = 'tenant-scope-workspace'

afterEach(() => resetPrisma())

function invoke(handler: ReturnType<typeof tenantResourceScope>, req: Partial<Request>) {
  return new Promise<{ error?: unknown; context?: string }>((resolve) => {
    const next: NextFunction = (error?: unknown) => resolve({ error, context: currentWorkspaceId() })
    handler(req as Request, {} as Response, next)
  })
}

test('resource tenant scope authorizes member and propagates workspace context downstream', async () => {
  const db = createFakePrisma({
    membership: {
      findFirst: async (args: any) => args?.where?.userId === USER && args?.where?.workspaceId === WS
        ? { id: 'm1', userId: USER, workspaceId: WS, role: 'member' }
        : null,
    },
  })
  installPrisma(db)
  const middleware = tenantResourceScope({
    resource: 'Campaign',
    loadWorkspace: async (id) => id === 'campaign-a' ? { workspaceId: WS } : null,
  })
  const result = await invoke(middleware, { user: { id: USER } as any, params: { id: 'campaign-a' } as any })
  assert.equal(result.error, undefined)
  assert.equal(result.context, WS)
  assert.equal(currentWorkspaceId(), undefined, 'tenant context must not leak after middleware chain returns')
})

test('resource tenant scope hides a foreign tenant resource as 404', async () => {
  const db = createFakePrisma({ membership: { findFirst: async () => null } })
  installPrisma(db)
  const middleware = tenantResourceScope({
    resource: 'Lead',
    loadWorkspace: async () => ({ workspaceId: 'foreign-workspace' }),
  })
  const result = await invoke(middleware, { user: { id: USER } as any, params: { id: 'lead-b' } as any })
  const err = result.error as { statusCode?: number; message?: string }
  assert.equal(err?.statusCode, 404)
  assert.equal(err?.message, 'Lead not found')
})

test('resource tenant scope returns the same 404 when the resource does not exist', async () => {
  const db = createFakePrisma({ membership: { findFirst: async () => { throw new Error('membership should not be queried') } } })
  installPrisma(db)
  const middleware = tenantResourceScope({ resource: 'Signal', loadWorkspace: async () => null })
  const result = await invoke(middleware, { user: { id: USER } as any, params: { id: 'missing' } as any })
  const err = result.error as { statusCode?: number; message?: string }
  assert.equal(err?.statusCode, 404)
  assert.equal(err?.message, 'Signal not found')
})

test('resource tenant scope returns 404 without a cross-workspace query when the request is scoped elsewhere', async () => {
  const db = createFakePrisma({ membership: { findFirst: async () => { throw new Error('membership should not be queried') } } })
  installPrisma(db)
  const middleware = tenantResourceScope({
    resource: 'Reply',
    param: 'replyId',
    loadWorkspace: async () => ({ workspaceId: 'foreign-workspace' }),
  })
  const result = await runInWorkspaceContext(WS, () =>
    invoke(middleware, { user: { id: USER } as any, params: { replyId: 'reply-b' } as any }))
  const err = result.error as { statusCode?: number; message?: string }
  assert.equal(err?.statusCode, 404)
  assert.equal(err?.message, 'Reply not found')
})
