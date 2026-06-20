/* global module */
const ERROR_MESSAGE = [
  'ACAOS is using the offline Prisma stub.',
  'Typecheck/build/test gates can run without downloading Prisma engines,',
  'but real database access is unavailable until a real client is generated.',
  'Run `npm run prisma:generate` in a networked environment before starting',
  'the API, worker, DB-backed tests, or any script that queries PostgreSQL.',
].join(' ')

function offlineError(method) {
  return new Error(`${ERROR_MESSAGE} Attempted: ${method}`)
}

function makeDelegate(name) {
  return new Proxy({}, {
    get(_target, property) {
      if (property === 'then') return undefined
      if (typeof property === 'symbol') return undefined
      return () => { throw offlineError(`${name}.${String(property)}`) }
    },
  })
}

class PrismaClient {
  constructor() {
    return new Proxy(this, {
      get(target, property, receiver) {
        if (property in target) return Reflect.get(target, property, receiver)
        if (property === 'then') return undefined
        if (typeof property === 'symbol') return undefined
        return makeDelegate(String(property))
      },
    })
  }

  async $connect() {}
  async $disconnect() {}
  async $transaction(arg) {
    if (typeof arg === 'function') {
      return arg(this)
    }
    throw offlineError('$transaction')
  }
  async $queryRaw() { throw offlineError('$queryRaw') }
  async $executeRaw() { throw offlineError('$executeRaw') }
  $on() {}
  $use() {}
}

const Prisma = {
  OfflineStub: true,
  defineExtension: (extension) => extension,
  getExtensionContext: () => { throw offlineError('Prisma.getExtensionContext') },
}

module.exports = {
  PrismaClient,
  Prisma,
  default: PrismaClient,
}
