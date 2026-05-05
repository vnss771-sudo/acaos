import test from 'node:test'
import assert from 'node:assert/strict'
import {
  appendSlugSuffix,
  buildWorkspaceName,
  buildWorkspaceSlugSeed,
  isValidEmail,
  normalizeEmail,
  normalizeOptionalString,
  sanitizeWorkspaceSlug,
  validatePassword
} from '../apps/api/src/lib/validation.ts'
import { getJwtSecret } from '../apps/api/src/lib/jwt.ts'

test('normalizeEmail trims and lowercases', () => {
  assert.equal(normalizeEmail('  USER@Example.COM  '), 'user@example.com')
})

test('isValidEmail accepts simple valid email and rejects malformed value', () => {
  assert.equal(isValidEmail('user@example.com'), true)
  assert.equal(isValidEmail('not-an-email'), false)
})

test('validatePassword enforces minimum length', () => {
  assert.equal(validatePassword('short'), 'Password must be at least 8 characters')
  assert.equal(validatePassword('long-enough'), '')
})

test('normalizeOptionalString returns undefined for empty values', () => {
  assert.equal(normalizeOptionalString('   '), undefined)
  assert.equal(normalizeOptionalString(' Team Alpha '), 'Team Alpha')
})

test('buildWorkspaceName prefers explicit name and falls back to email local part', () => {
  assert.equal(buildWorkspaceName('Acme Ops', 'owner@example.com'), "Acme Ops's Workspace")
  assert.equal(buildWorkspaceName(undefined, 'owner@example.com'), "owner's Workspace")
})

test('sanitizeWorkspaceSlug removes unsupported characters and duplicate dashes', () => {
  assert.equal(sanitizeWorkspaceSlug('  ACME Ops / Team  '), 'acme-ops-team')
  assert.equal(sanitizeWorkspaceSlug('___'), '')
})

test('buildWorkspaceSlugSeed falls back to workspace when source becomes empty', () => {
  assert.equal(buildWorkspaceSlugSeed('Sales Team', 'owner@example.com'), 'sales-team')
  assert.equal(buildWorkspaceSlugSeed(undefined, 'owner@example.com'), 'owner')
})

test('appendSlugSuffix preserves a safe slug', () => {
  assert.equal(appendSlugSuffix('sales-team', 2), 'sales-team-2')
})

test('getJwtSecret allows the development fallback secret', () => {
  const originalNodeEnv = process.env.NODE_ENV
  const originalJwtSecret = process.env.JWT_SECRET

  delete process.env.NODE_ENV
  delete process.env.JWT_SECRET

  try {
    assert.equal(getJwtSecret(), 'change-me')
  } finally {
    process.env.NODE_ENV = originalNodeEnv
    process.env.JWT_SECRET = originalJwtSecret
  }
})

test('getJwtSecret requires an explicit non-default production secret', () => {
  const originalNodeEnv = process.env.NODE_ENV
  const originalJwtSecret = process.env.JWT_SECRET

  process.env.NODE_ENV = 'production'
  delete process.env.JWT_SECRET
  assert.throws(() => getJwtSecret(), /JWT_SECRET is required in production/)

  process.env.JWT_SECRET = 'change-me'
  assert.throws(() => getJwtSecret(), /JWT_SECRET must be changed in production/)

  process.env.JWT_SECRET = 'production-secret'
  assert.equal(getJwtSecret(), 'production-secret')

  process.env.NODE_ENV = originalNodeEnv
  process.env.JWT_SECRET = originalJwtSecret
})
