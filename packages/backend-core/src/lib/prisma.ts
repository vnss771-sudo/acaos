import { PrismaClient } from '@prisma/client'
import { currentWorkspaceId } from './tenantContext.js'
import { classifyTenantAccess, tenantGuardMode } from './tenantGuard.js'

declare global {
  // `var` is required here: ambient global augmentation can't use let/const.
  var __acaosPrisma__: PrismaClient | undefined
}

function createPrismaClient() {
  const base = new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error']
  })

  // Defense-in-depth tenant guard. Inert (and not even installed) unless
  // TENANT_GUARD_MODE is observe/enforce, so production behaviour is unchanged by
  // default. When active, every operation that runs inside a tenant context (see
  // tenantContext.ts) is classified; a multi-row query on a tenant model with no
  // workspace/FK scoping is the catastrophic cross-tenant case — observe logs it,
  // enforce rejects it. Scoped and scoped-via-FK queries pass through untouched.
  const mode = tenantGuardMode()
  if (mode === 'off') return base
  return base.$extends({
    query: {
      // Params are annotated explicitly: the deterministic-offline build types the
      // Prisma client as `{ [k: string]: any }` (no generated types), so without an
      // annotation these bindings are implicitly `any` and fail under noImplicitAny.
      async $allOperations({ model, operation, args, query }: {
        model?: string
        operation: string
        args: unknown
        query: (args: unknown) => Promise<unknown>
      }) {
        const { result, reason } = classifyTenantAccess({
          model, operation, args, workspaceId: currentWorkspaceId(),
        })
        if (result === 'unscoped') {
          const message = `[tenant-guard] blocked cross-tenant access: ${reason}`
          if (mode === 'enforce') throw new Error(message)
          console.warn(message)
        }
        return query(args)
      },
    },
  }) as unknown as PrismaClient
}

function getClient() {
  if (!globalThis.__acaosPrisma__) {
    globalThis.__acaosPrisma__ = createPrismaClient()
  }
  return globalThis.__acaosPrisma__
}

export const prisma = new Proxy({} as PrismaClient, {
  get(_target, property, receiver) {
    const client = getClient()
    return Reflect.get(client as object, property, receiver)
  }
})
