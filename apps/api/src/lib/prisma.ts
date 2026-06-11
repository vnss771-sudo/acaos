import { PrismaClient } from '@prisma/client'
import { cfg } from './env.js'

declare global {
  // eslint-disable-next-line no-var
  var __acaosPrisma__: PrismaClient | undefined
}

function createPrismaClient() {
  return new PrismaClient({
    log: cfg.nodeEnv === 'development' ? ['warn', 'error'] : ['error']
  })
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
