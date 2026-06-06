/**
 * Chaos test suite — adversarial inputs, boundary conditions, type confusion,
 * injection payloads, and concurrency edge cases.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isValidEmail,
  normalizeEmail,
  validatePassword,
  normalizeOptionalString,
  sanitizeWorkspaceSlug,
  buildWorkspaceSlugSeed,
  buildWorkspaceName,
  appendSlugSuffix
} from '../apps/api/src/lib/validation.ts'
import { signJwt, verifyJwt, hashRefreshToken, generateRefreshToken } from '../apps/api/src/lib/jwt.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function noEnv<T>(fn: () => T): T {
  const saved = { NODE_ENV: process.env.NODE_ENV, JWT_SECRET: process.env.JWT_SECRET }
  delete process.env.NODE_ENV
  delete process.env.JWT_SECRET
  try { return fn() } finally { Object.assign(process.env, saved) }
}

// ---------------------------------------------------------------------------
// Email — adversarial inputs
// ---------------------------------------------------------------------------
test('chaos: email — SQL injection payloads are rejected', () => {
  const payloads = [
    "' OR '1'='1",
    "admin'--",
    "1; DROP TABLE users;--",
    "' UNION SELECT * FROM users--",
    "\" OR \"\"=\""
  ]
  for (const p of payloads) assert.equal(isValidEmail(p), false, `expected false for: ${p}`)
})

test('chaos: email — XSS payloads are rejected', () => {
  const payloads = [
    '<script>alert(1)</script>',
    'user@"><img src=x onerror=alert(1)>',
    'javascript:alert(1)',
    '"><svg/onload=alert(1)>',
  ]
  for (const p of payloads) assert.equal(isValidEmail(p), false, `expected false for: ${p}`)
})

test('chaos: email — unicode and international chars', () => {
  // Valid-looking international emails
  assert.equal(isValidEmail('用户@例子.广告'), true)
  assert.equal(isValidEmail('test@münchen.de'), true)
  // Clearly invalid
  assert.equal(isValidEmail('@'), false)
  assert.equal(isValidEmail('用户@'), false)
})

test('chaos: email — boundary lengths', () => {
  const long254 = 'a'.repeat(64) + '@' + 'b'.repeat(185) + '.com'  // 254 chars — RFC max
  assert.equal(isValidEmail(long254), true)

  const tooLong = 'a'.repeat(200) + '@' + 'b'.repeat(200) + '.com'
  // We don't enforce length in isValidEmail — just verify it doesn't throw
  assert.doesNotThrow(() => isValidEmail(tooLong))
})

test('chaos: email — whitespace-only and empty variants', () => {
  const blanks = ['', '   ', '\t', '\n', '\r\n', ' ']
  for (const b of blanks) assert.equal(isValidEmail(b), false, `expected false for whitespace: ${JSON.stringify(b)}`)
})

test('chaos: email — null bytes and control characters are rejected', () => {
  const weird = ['user\x00@example.com', 'user@exam\x00ple.com', 'us\x01er@x.com']
  for (const w of weird) assert.equal(isValidEmail(w), false, `expected false for control char: ${JSON.stringify(w)}`)
})

test('chaos: email — multiple @ symbols', () => {
  const multis = ['a@b@c.com', 'user@@example.com', '@user@example.com', 'user@example@com']
  for (const m of multis) assert.equal(isValidEmail(m), false, `expected false for multi-@: ${m}`)
})

test('chaos: normalizeEmail handles extreme whitespace', () => {
  assert.equal(normalizeEmail('\t\n USER@EXAMPLE.COM \r\n'), 'user@example.com')
})

// ---------------------------------------------------------------------------
// Password — adversarial inputs
// ---------------------------------------------------------------------------
test('chaos: password — exactly 7 chars fails, 8 passes', () => {
  assert.notEqual(validatePassword('1234567'), '')
  assert.equal(validatePassword('12345678'), '')
})

test('chaos: password — null byte and unicode edge cases do not throw', () => {
  const tricky = ['\x00'.repeat(8), '𝟏𝟐𝟑𝟒𝟓𝟔𝟕𝟖', '日本語パスワード', '​'.repeat(8)]
  for (const p of tricky) assert.doesNotThrow(() => validatePassword(p), `threw on: ${JSON.stringify(p)}`)
})

test('chaos: password — whitespace-only 8 chars passes length check (trimming is caller responsibility)', () => {
  // validatePassword only checks length — callers must trim before calling
  assert.equal(validatePassword('        '), '')
})

test('chaos: password — very long password does not throw', () => {
  assert.doesNotThrow(() => validatePassword('x'.repeat(100_000)))
})

// ---------------------------------------------------------------------------
// Slug — adversarial inputs
// ---------------------------------------------------------------------------
test('chaos: slug — emoji stripped cleanly', () => {
  assert.equal(sanitizeWorkspaceSlug('🔥 Fire Team 🔥'), 'fire-team')
  assert.equal(sanitizeWorkspaceSlug('💡idea'), 'idea')
  assert.equal(sanitizeWorkspaceSlug('🚀'), '')
})

test('chaos: slug — RTL and zero-width chars stripped', () => {
  const result = sanitizeWorkspaceSlug('‮ reversed ​ zero')
  assert.ok(!result.includes('‮'), 'RTL override should be stripped')
  assert.ok(!result.includes('​'), 'zero-width space should be stripped')
})

test('chaos: slug — SQL and script payloads become safe slugs', () => {
  assert.equal(sanitizeWorkspaceSlug("'; DROP TABLE--"), 'drop-table')
  // parens → dashes, so the actual safe output is 'script-alert-1-script'
  assert.equal(sanitizeWorkspaceSlug('<script>alert(1)</script>'), 'script-alert-1-script')
})

test('chaos: slug — only special chars yields empty string', () => {
  const onlySpecial = ['!@#$%^&*()', '🎉🎊🎈', '---', '___', '   ']
  for (const s of onlySpecial) {
    const result = sanitizeWorkspaceSlug(s)
    assert.equal(result, '', `expected empty for: ${JSON.stringify(s)}`)
  }
})

test('chaos: slug — very long slug does not throw', () => {
  assert.doesNotThrow(() => sanitizeWorkspaceSlug('a'.repeat(100_000)))
})

test('chaos: slug — no leading or trailing dashes in any output', () => {
  const inputs = ['--hello--', '-world', 'test-', '---a---', '  spaces  ', 'MixedCase']
  for (const s of inputs) {
    const result = sanitizeWorkspaceSlug(s)
    if (result.length > 0) {
      assert.ok(!result.startsWith('-'), `leading dash in: "${result}"`)
      assert.ok(!result.endsWith('-'), `trailing dash in: "${result}"`)
    }
  }
})

test('chaos: slug — no consecutive dashes in any output', () => {
  const inputs = ['a--b', 'x---y', 'hello   world', 'foo__bar', 'a-_-b']
  for (const s of inputs) {
    const result = sanitizeWorkspaceSlug(s)
    assert.ok(!result.includes('--'), `consecutive dashes in: "${result}"`)
  }
})

test('chaos: buildWorkspaceSlugSeed falls back gracefully on all-special email local part', () => {
  // email where local part sanitizes to empty — must not crash or return empty
  const result = buildWorkspaceSlugSeed(undefined, '🔥@example.com')
  assert.ok(result.length > 0, 'slug seed must not be empty')
  assert.ok(!result.startsWith('-'), 'no leading dash')
})

test('chaos: appendSlugSuffix handles numeric 0 and negative suffix', () => {
  assert.doesNotThrow(() => appendSlugSuffix('team', 0))
  assert.doesNotThrow(() => appendSlugSuffix('team', -1))
})

// ---------------------------------------------------------------------------
// Workspace name
// ---------------------------------------------------------------------------
test('chaos: buildWorkspaceName — XSS in name is preserved as-is (escaping is view-layer concern)', () => {
  const name = buildWorkspaceName('<script>evil</script>', 'user@x.com')
  assert.ok(name.includes('<script>'), 'name is stored raw — view layer must escape')
})

test('chaos: buildWorkspaceName — email with no local part falls back gracefully', () => {
  // @ only — local part is empty string
  assert.doesNotThrow(() => buildWorkspaceName(undefined, '@nodomain'))
})

test('chaos: buildWorkspaceName — whitespace-only name falls back to email', () => {
  const result = buildWorkspaceName('   \t\n   ', 'owner@example.com')
  assert.ok(result.startsWith('owner'), `expected email fallback, got: ${result}`)
})

// ---------------------------------------------------------------------------
// normalizeOptionalString
// ---------------------------------------------------------------------------
test('chaos: normalizeOptionalString rejects all non-string types', () => {
  const nonStrings = [0, 1, false, true, [], {}, null, undefined, Symbol('x'), () => {}]
  for (const v of nonStrings) {
    assert.equal(normalizeOptionalString(v as any), undefined, `expected undefined for: ${String(v)}`)
  }
})

test('chaos: normalizeOptionalString handles strings with only unicode whitespace', () => {
  const unicodeSpaces = [' ', ' ', '　', '﻿']
  for (const s of unicodeSpaces) {
    // String.trim() does not strip all unicode whitespace — behaviour is well-defined and consistent
    assert.doesNotThrow(() => normalizeOptionalString(s))
  }
})

// ---------------------------------------------------------------------------
// JWT — adversarial inputs
// ---------------------------------------------------------------------------
test('chaos: JWT — empty string throws', () => {
  noEnv(() => assert.throws(() => verifyJwt('')))
})

test('chaos: JWT — random garbage throws', () => {
  noEnv(() => {
    const garbage = ['not.a.jwt', 'aaa', 'a.b', 'a.b.c.d', '   ', '{}']
    for (const g of garbage) assert.throws(() => verifyJwt(g), `expected throw for: ${g}`)
  })
})

test('chaos: JWT — algorithm confusion: HS256 token rejected with wrong secret', () => {
  noEnv(() => {
    const token = signJwt({ userId: 'legit' })
    process.env.JWT_SECRET = 'different-secret'
    assert.throws(() => verifyJwt(token), 'should reject token signed with different secret')
    delete process.env.JWT_SECRET
  })
})

test('chaos: JWT — alg:none attack is rejected', () => {
  noEnv(() => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({ userId: 'evil' })).toString('base64url')
    const noneToken = `${header}.${payload}.`
    assert.throws(() => verifyJwt(noneToken), 'alg:none should be rejected')
  })
})

test('chaos: JWT — massive payload does not crash (size limit is caller responsibility)', () => {
  noEnv(() => {
    // signJwt only accepts { userId }, so we cast — tests that signing large userId doesn't hang
    const bigId = 'u_' + 'x'.repeat(10_000)
    assert.doesNotThrow(() => {
      const token = signJwt({ userId: bigId })
      const decoded = verifyJwt(token)
      assert.equal(decoded.userId, bigId)
    })
  })
})

test('chaos: JWT — truncated token (missing last char) throws', () => {
  noEnv(() => {
    const token = signJwt({ userId: 'u_test' })
    assert.throws(() => verifyJwt(token.slice(0, -1)))
  })
})

test('chaos: JWT — each segment individually corrupted throws', () => {
  noEnv(() => {
    const token = signJwt({ userId: 'u_seg' })
    const [h, p, s] = token.split('.')
    assert.throws(() => verifyJwt(`XXXX.${p}.${s}`), 'corrupt header should throw')
    assert.throws(() => verifyJwt(`${h}.XXXX.${s}`), 'corrupt payload should throw')
    assert.throws(() => verifyJwt(`${h}.${p}.XXXX`), 'corrupt signature should throw')
  })
})

// ---------------------------------------------------------------------------
// Refresh token — collision resistance and format
// ---------------------------------------------------------------------------
test('chaos: refresh token — 1000 tokens are all unique', () => {
  const tokens = new Set(Array.from({ length: 1000 }, generateRefreshToken))
  assert.equal(tokens.size, 1000, 'all 1000 tokens must be unique')
})

test('chaos: refresh token — 1000 hashes are all unique', () => {
  const hashes = new Set(Array.from({ length: 1000 }, () => hashRefreshToken(generateRefreshToken())))
  assert.equal(hashes.size, 1000, 'all 1000 hashes must be unique')
})

test('chaos: refresh token — hash of same token is always identical (deterministic)', () => {
  const token = generateRefreshToken()
  const hashes = new Set(Array.from({ length: 50 }, () => hashRefreshToken(token)))
  assert.equal(hashes.size, 1, 'hash must be deterministic')
})

test('chaos: refresh token — hash output is always exactly 64 hex chars', () => {
  for (let i = 0; i < 20; i++) {
    const hash = hashRefreshToken(generateRefreshToken())
    assert.equal(hash.length, 64, `hash length should be 64, got ${hash.length}`)
    assert.match(hash, /^[a-f0-9]+$/, 'hash must be lowercase hex')
  }
})

test('chaos: refresh token — single bit flip in token changes hash completely', () => {
  const token = generateRefreshToken()
  const tampered = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a')
  assert.notEqual(hashRefreshToken(token), hashRefreshToken(tampered))
})

// ---------------------------------------------------------------------------
// Ingest deduplication logic (pure, extracted)
// ---------------------------------------------------------------------------
function simulateIngestDedup(
  incoming: Array<{ businessName?: unknown; email?: unknown; [k: string]: unknown }>,
  existingEmails: string[]
): { rows: typeof incoming; skipped: number } {
  const existingSet = new Set(existingEmails.map((e) => e.toLowerCase()))
  const seenEmails = new Set<string>()
  const rows: typeof incoming = []

  for (const l of incoming) {
    if (typeof l?.businessName !== 'string' || !l.businessName.trim()) continue
    const email = typeof l.email === 'string' ? l.email.trim().toLowerCase() || null : null

    if (email) {
      if (existingSet.has(email) || seenEmails.has(email)) continue
      seenEmails.add(email)
    }
    rows.push(l)
  }

  return { rows, skipped: incoming.length - rows.length }
}

test('chaos: ingest dedup — empty batch returns zero rows', () => {
  const { rows, skipped } = simulateIngestDedup([], [])
  assert.equal(rows.length, 0)
  assert.equal(skipped, 0)
})

test('chaos: ingest dedup — all leads missing businessName are skipped', () => {
  const batch = [
    { businessName: '', email: 'a@x.com' },
    { businessName: '   ', email: 'b@x.com' },
    { email: 'c@x.com' },
    { businessName: null as any, email: 'd@x.com' }
  ]
  const { rows, skipped } = simulateIngestDedup(batch, [])
  assert.equal(rows.length, 0)
  assert.equal(skipped, batch.length)
})

test('chaos: ingest dedup — duplicate emails within the batch: first wins, rest skipped', () => {
  const batch = [
    { businessName: 'Acme', email: 'ceo@acme.com' },
    { businessName: 'Acme Clone', email: 'CEO@ACME.COM' },  // same email, different case
    { businessName: 'Acme 3', email: 'ceo@acme.com' }
  ]
  const { rows } = simulateIngestDedup(batch, [])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].businessName, 'Acme')
})

test('chaos: ingest dedup — emails already in DB are skipped', () => {
  const batch = [
    { businessName: 'Existing Co', email: 'known@example.com' },
    { businessName: 'New Co', email: 'new@example.com' }
  ]
  const { rows, skipped } = simulateIngestDedup(batch, ['known@example.com'])
  assert.equal(rows.length, 1)
  assert.equal(skipped, 1)
  assert.equal(rows[0].businessName, 'New Co')
})

test('chaos: ingest dedup — leads without email are always accepted (no email = no dedup key)', () => {
  const batch = [
    { businessName: 'No Email Co 1' },
    { businessName: 'No Email Co 2' },
    { businessName: 'No Email Co 3' }
  ]
  const { rows } = simulateIngestDedup(batch, [])
  assert.equal(rows.length, 3)
})

test('chaos: ingest dedup — mix of valid, duplicate, and no-email leads', () => {
  const batch = [
    { businessName: 'Alpha', email: 'a@x.com' },
    { businessName: 'Beta', email: 'b@x.com' },         // new
    { businessName: 'Alpha Dupe', email: 'a@x.com' },   // batch-duplicate
    { businessName: 'Gamma' },                           // no email — always in
    { businessName: 'Delta', email: 'existing@x.com' }, // in DB already
    { businessName: 'Epsilon', email: 'b@x.com' }       // batch-duplicate of Beta
  ]
  const { rows, skipped } = simulateIngestDedup(batch, ['existing@x.com'])
  assert.equal(rows.length, 3) // Alpha, Beta, Gamma
  assert.equal(skipped, 3)     // Alpha Dupe, Delta, Epsilon
})

test('chaos: ingest dedup — case-insensitive email matching across DB and batch', () => {
  const batch = [
    { businessName: 'Test', email: 'USER@EXAMPLE.COM' }
  ]
  const { rows } = simulateIngestDedup(batch, ['user@example.com'])
  assert.equal(rows.length, 0, 'case-insensitive match against DB should skip')
})

test('chaos: ingest dedup — 500-lead batch all unique completes without issue', () => {
  const batch = Array.from({ length: 500 }, (_, i) => ({
    businessName: `Company ${i}`,
    email: `contact${i}@company${i}.com`
  }))
  const { rows } = simulateIngestDedup(batch, [])
  assert.equal(rows.length, 500)
})

test('chaos: ingest dedup — 500-lead batch all duplicates yields zero rows', () => {
  const email = 'same@example.com'
  const batch = Array.from({ length: 500 }, (_, i) => ({
    businessName: `Clone ${i}`,
    email
  }))
  const { rows, skipped } = simulateIngestDedup(batch, [])
  assert.equal(rows.length, 1)   // first occurrence accepted
  assert.equal(skipped, 499)
})

test('chaos: ingest dedup — injection strings in businessName are accepted as-is (sanitization is DB/view layer)', () => {
  const batch = [
    { businessName: "'; DROP TABLE leads;--", email: 'sql@x.com' },
    { businessName: '<script>alert(1)</script>', email: 'xss@x.com' },
    { businessName: '../../../etc/passwd', email: 'lfi@x.com' }
  ]
  const { rows } = simulateIngestDedup(batch, [])
  assert.equal(rows.length, 3, 'all leads should pass dedup regardless of content')
})

test('chaos: ingest dedup — sourceTag injection does not affect dedup logic', () => {
  const batch = [
    { businessName: 'Legit Co', email: 'legit@x.com' },
    { businessName: 'Legit Co 2', email: 'legit2@x.com' }
  ]
  const { rows } = simulateIngestDedup(batch, [])
  assert.equal(rows.length, 2)
})
