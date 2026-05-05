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
import { getJwtSecret, signJwt, verifyJwt, generateRefreshToken, hashRefreshToken } from '../apps/api/src/lib/jwt.ts'

// ── Email ─────────────────────────────────────────────────────────────────────
test('normalizeEmail trims and lowercases', () => {
  assert.equal(normalizeEmail('  USER@Example.COM  '), 'user@example.com')
})

test('isValidEmail accepts simple valid email and rejects malformed value', () => {
  assert.equal(isValidEmail('user@example.com'), true)
  assert.equal(isValidEmail('not-an-email'), false)
  assert.equal(isValidEmail('user@'), false)
  assert.equal(isValidEmail(''), false)
})

// ── Password ──────────────────────────────────────────────────────────────────
test('validatePassword enforces minimum length', () => {
  assert.equal(validatePassword('short'), 'Password must be at least 8 characters')
  assert.equal(validatePassword('long-enough'), '')
  assert.equal(validatePassword('exactly8'), '')
})

// ── String helpers ────────────────────────────────────────────────────────────
test('normalizeOptionalString returns undefined for empty values', () => {
  assert.equal(normalizeOptionalString('   '), undefined)
  assert.equal(normalizeOptionalString(' Team Alpha '), 'Team Alpha')
  assert.equal(normalizeOptionalString(42), undefined)
  assert.equal(normalizeOptionalString(null), undefined)
})

test('buildWorkspaceName prefers explicit name and falls back to email local part', () => {
  assert.equal(buildWorkspaceName('Acme Ops', 'owner@example.com'), "Acme Ops's Workspace")
  assert.equal(buildWorkspaceName(undefined, 'owner@example.com'), "owner's Workspace")
  assert.equal(buildWorkspaceName('   ', 'owner@example.com'), "owner's Workspace")
})

// ── Slug helpers ──────────────────────────────────────────────────────────────
test('sanitizeWorkspaceSlug removes unsupported characters and duplicate dashes', () => {
  assert.equal(sanitizeWorkspaceSlug('  ACME Ops / Team  '), 'acme-ops-team')
  assert.equal(sanitizeWorkspaceSlug('___'), '')
  assert.equal(sanitizeWorkspaceSlug('MyWorkspace'), 'myworkspace')
  assert.equal(sanitizeWorkspaceSlug('a---b'), 'a-b')
  assert.equal(sanitizeWorkspaceSlug('--hello--'), 'hello')
})

test('buildWorkspaceSlugSeed falls back to workspace when source becomes empty', () => {
  assert.equal(buildWorkspaceSlugSeed('Sales Team', 'owner@example.com'), 'sales-team')
  assert.equal(buildWorkspaceSlugSeed(undefined, 'owner@example.com'), 'owner')
})

test('appendSlugSuffix preserves a safe slug', () => {
  assert.equal(appendSlugSuffix('sales-team', 2), 'sales-team-2')
  assert.equal(appendSlugSuffix('workspace', 99), 'workspace-99')
})

// ── JWT ───────────────────────────────────────────────────────────────────────
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

test('signJwt produces a three-part JWT string', () => {
  const prevEnv = process.env.NODE_ENV
  const prevSecret = process.env.JWT_SECRET
  delete process.env.NODE_ENV
  delete process.env.JWT_SECRET
  try {
    const token = signJwt({ userId: 'u_test123' })
    assert.ok(typeof token === 'string')
    assert.equal(token.split('.').length, 3)
  } finally {
    process.env.NODE_ENV = prevEnv
    process.env.JWT_SECRET = prevSecret
  }
})

test('verifyJwt decodes correct userId', () => {
  const prevEnv = process.env.NODE_ENV
  const prevSecret = process.env.JWT_SECRET
  delete process.env.NODE_ENV
  delete process.env.JWT_SECRET
  try {
    const token = signJwt({ userId: 'u_decode_test' })
    const payload = verifyJwt(token)
    assert.equal(payload.userId, 'u_decode_test')
  } finally {
    process.env.NODE_ENV = prevEnv
    process.env.JWT_SECRET = prevSecret
  }
})

test('verifyJwt throws on tampered payload', () => {
  const prevEnv = process.env.NODE_ENV
  const prevSecret = process.env.JWT_SECRET
  delete process.env.NODE_ENV
  delete process.env.JWT_SECRET
  try {
    const token = signJwt({ userId: 'legit' })
    const parts = token.split('.')
    parts[1] = Buffer.from(JSON.stringify({ userId: 'hacked' })).toString('base64url')
    assert.throws(() => verifyJwt(parts.join('.')))
  } finally {
    process.env.NODE_ENV = prevEnv
    process.env.JWT_SECRET = prevSecret
  }
})

// ── Refresh tokens ────────────────────────────────────────────────────────────
test('generateRefreshToken produces 80-char lowercase hex string', () => {
  const token = generateRefreshToken()
  assert.equal(token.length, 80)
  assert.match(token, /^[a-f0-9]+$/)
})

test('hashRefreshToken is deterministic', () => {
  const token = generateRefreshToken()
  assert.equal(hashRefreshToken(token), hashRefreshToken(token))
})

test('different refresh tokens produce different hashes', () => {
  const t1 = generateRefreshToken()
  const t2 = generateRefreshToken()
  assert.notEqual(hashRefreshToken(t1), hashRefreshToken(t2))
})

test('refresh token hash is not the same as the raw token', () => {
  const token = generateRefreshToken()
  const hash = hashRefreshToken(token)
  assert.notEqual(hash, token)
  assert.equal(hash.length, 64)
})
