import test from 'node:test'
import assert from 'node:assert/strict'
import type { Request } from 'express'
import { requireUser, ApiError } from '../apps/api/src/lib/http.ts'
import type { AuthUser } from '../apps/api/src/types/auth.ts'

const USER: AuthUser = { id: 'u1', email: 'u@x.test', name: null, emailVerified: true, isPlatformAdmin: false }

test('requireUser returns the attached user', () => {
  const req = { user: USER } as unknown as Request
  assert.equal(requireUser(req), USER)
})

test('requireUser throws a 401 ApiError when no user is attached (route mounted without requireAuth)', () => {
  const req = {} as Request
  assert.throws(() => requireUser(req), (err: unknown) => {
    assert.ok(err instanceof ApiError)
    assert.equal((err as ApiError).statusCode, 401)
    return true
  })
})
