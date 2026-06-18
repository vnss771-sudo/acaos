// Integration-test harness for the Express API.
//
// The production code accesses the database through `lib/prisma.ts`, which
// resolves a singleton from `globalThis.__acaosPrisma__` lazily (only when a
// property is read, i.e. at request time). That lets us inject a fake Prisma
// client *before any request runs* without a live PostgreSQL instance, so we
// can exercise the real route handlers, middleware, and error handling.
//
// Requests go over a real ephemeral-port HTTP server via the built-in fetch,
// so the full Express stack (routing, JSON parsing, auth middleware, error
// handler) is exercised end to end — no new dependencies required.

import express, { type Router } from 'express'
import type { Server } from 'node:http'
import { errorHandler, notFoundHandler } from '../../apps/api/src/lib/http.ts'
import { signJwt } from '../../packages/backend-core/src/lib/jwt.ts'

export type PrismaMethod = (...args: any[]) => unknown
export type FakeModel = Record<string, PrismaMethod>
// A spec entry is either a model (object of methods) or a top-level client
// function such as `$transaction`.
export type FakePrismaSpec = Record<string, FakeModel | PrismaMethod>

export type RecordedCall = { model: string; method: string; args: unknown[] }

export type FakePrisma = FakePrismaSpec & {
  __calls: RecordedCall[]
  /** All recorded calls for a given `model.method`. */
  callsTo(model: string, method: string): RecordedCall[]
}

/**
 * Build a fake Prisma client from a spec. Every method is wrapped so that
 * invocations are recorded on `prisma.__calls`, enabling assertions such as
 * "signal.delete was never called" for authorization tests.
 */
export function createFakePrisma(spec: FakePrismaSpec): FakePrisma {
  const calls: RecordedCall[] = []
  const fake: Record<string, unknown> = {
    __calls: calls,
    callsTo: (model: string, method: string) =>
      calls.filter((c) => c.model === model && c.method === method),
  }

  for (const [model, methods] of Object.entries(spec)) {
    // Top-level client functions (e.g. $transaction) are attached directly.
    if (typeof methods === 'function') {
      fake[model] = methods
      continue
    }
    const wrapped: FakeModel = {}
    for (const [method, fn] of Object.entries(methods)) {
      wrapped[method] = (...args: unknown[]) => {
        calls.push({ model, method, args })
        return fn(...args)
      }
    }
    fake[model] = wrapped
  }

  // Default $transaction supporting both the array form
  // (prisma.$transaction([...promises])) and the interactive callback form
  // (prisma.$transaction(async (tx) => ...)), unless the spec overrides it.
  if (!('$transaction' in fake)) {
    fake.$transaction = (arg: unknown) =>
      Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => unknown)(fake)
  }
  // Raw query helpers (e.g. advisory locks) default to no-ops.
  if (!('$executeRaw' in fake)) fake.$executeRaw = async () => 0
  if (!('$queryRaw' in fake)) fake.$queryRaw = async () => []

  return fake as FakePrisma
}

/** Install a fake Prisma client for the duration of a test. */
export function installPrisma(fake: FakePrisma): void {
  ;(globalThis as { __acaosPrisma__?: unknown }).__acaosPrisma__ = fake
}

/** Remove any installed fake Prisma client. */
export function resetPrisma(): void {
  delete (globalThis as { __acaosPrisma__?: unknown }).__acaosPrisma__
}

/** A signed `Authorization` header value for the given user id. */
export function bearer(userId: string): string {
  return `Bearer ${signJwt({ userId })}`
}

export type TestServer = {
  baseUrl: string
  close: () => Promise<void>
  request: (
    path: string,
    init?: RequestInit
  ) => Promise<{ status: number; headers: Headers; body: any }>
}

/**
 * Mount a router (optionally with the raw-body handling some routes need) and
 * start it on an ephemeral port. Returns helpers to make requests and tear down.
 */
export async function startTestServer(
  mountPath: string,
  router: Router,
  opts: { configure?: (app: express.Express) => void } = {}
): Promise<TestServer> {
  const app = express()
  app.set('trust proxy', 1)
  opts.configure?.(app)
  app.use(express.json())
  app.use(mountPath, router)
  app.use(notFoundHandler)
  app.use(errorHandler)

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s))
  })
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  const baseUrl = `http://127.0.0.1:${port}`

  return {
    baseUrl,
    close: () => new Promise<void>((r) => server.close(() => r())),
    async request(path, init) {
      const res = await fetch(`${baseUrl}${path}`, init)
      const text = await res.text()
      let body: unknown = text
      try {
        body = text ? JSON.parse(text) : null
      } catch {
        /* keep raw text */
      }
      return { status: res.status, headers: res.headers, body }
    },
  }
}
