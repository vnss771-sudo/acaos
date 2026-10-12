// D2: Spam Act 2003 consent evidence + send authorization (unit tier, fake prisma).
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { validateAuConsentEvidence, isQualifyingAuConsent } from '../packages/backend-core/src/lib/auConsent.ts'
import { hasAuConsent, bulkCheckAuConsent, hasConsent } from '../packages/backend-core/src/lib/consent.ts'
import { authorizeOutboundSend } from '../packages/backend-core/src/services/sendAuthorization.ts'
import { isAuCommercialSendingEnabled } from '../packages/backend-core/src/lib/launchControls.ts'
import { createFakePrisma, installPrisma, resetPrisma } from './helpers/integration.ts'

const PAST = new Date('2026-09-01T00:00:00Z')
const published = (over: Record<string, unknown> = {}) => ({
  basis: 'inferred_conspicuous_publication', evidenceUrl: 'https://acme.example/contact', evidenceAt: PAST,
  addressType: 'role', optOutStatementAbsent: true, roleRelevant: true, ...over,
})
const express = (over: Record<string, unknown> = {}) => ({
  basis: 'express', evidenceAt: PAST, evidenceExcerpt: 'Ticked "yes, email me quotes" on form', ...over,
})

const saved = { au: process.env.AU_COMMERCIAL_SENDING_ENABLED, gate: process.env.COMPLIANCE_GATE_ENABLED, rep: process.env.REPUTATION_GUARD_MODE }
afterEach(() => {
  resetPrisma()
  for (const [k, v] of [['AU_COMMERCIAL_SENDING_ENABLED', saved.au], ['COMPLIANCE_GATE_ENABLED', saved.gate], ['REPUTATION_GUARD_MODE', saved.rep]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
})

// ── evidence rules ────────────────────────────────────────────────────────────
test('AU evidence: legitimate_interest and the legacy CASL bases never qualify', () => {
  for (const basis of ['legitimate_interest', 'express_consent', 'implied_consent', '']) {
    assert.equal(isQualifyingAuConsent({ basis, evidenceAt: PAST, evidenceUrl: 'https://a.example', evidenceExcerpt: 'long enough excerpt' }), false, basis)
  }
})

test('AU evidence: valid express and valid conspicuous-publication records qualify', () => {
  assert.equal(validateAuConsentEvidence(express()).ok, true)
  assert.equal(validateAuConsentEvidence(published()).ok, true)
})

test('AU evidence: publication alone is not consent — every Schedule 2 element is required', () => {
  assert.equal(isQualifyingAuConsent(published({ evidenceUrl: null })), false, 'no source URL')
  assert.equal(isQualifyingAuConsent(published({ evidenceUrl: 'not a url' })), false, 'malformed URL')
  assert.equal(isQualifyingAuConsent(published({ evidenceAt: null })), false, 'no date seen')
  assert.equal(isQualifyingAuConsent(published({ addressType: null })), false, 'address type unknown')
  assert.equal(isQualifyingAuConsent(published({ addressType: 'shared' })), false)
  assert.equal(isQualifyingAuConsent(published({ optOutStatementAbsent: false })), false, 'opt-out statement present')
  assert.equal(isQualifyingAuConsent(published({ optOutStatementAbsent: null })), false, 'opt-out check not done')
  assert.equal(isQualifyingAuConsent(published({ roleRelevant: false })), false)
  assert.equal(isQualifyingAuConsent(published({ roleRelevant: null })), false)
})

test('AU evidence: express consent needs a date and documentation; future dates are rejected', () => {
  assert.equal(isQualifyingAuConsent(express({ evidenceAt: null })), false)
  assert.equal(isQualifyingAuConsent(express({ evidenceExcerpt: null, evidenceUrl: null })), false)
  assert.equal(isQualifyingAuConsent(express({ evidenceExcerpt: 'short' })), false)
  assert.equal(isQualifyingAuConsent(express({ evidenceExcerpt: null, evidenceUrl: 'https://acme.example/form' })), true)
  assert.equal(isQualifyingAuConsent(express({ evidenceAt: new Date(Date.now() + 86_400_000) })), false)
  assert.equal(isQualifyingAuConsent(express({ evidenceAt: 'garbage' })), false)
})

// ── lookups ───────────────────────────────────────────────────────────────────
test('hasAuConsent / bulkCheckAuConsent: only AU bases with valid evidence pass; legacy hasConsent ignores AU bases', async () => {
  const rows = [
    { emailKey: 'good@x.test', ...express() },
    { emailKey: 'thin@x.test', ...published({ roleRelevant: null }) },
  ]
  const seenBasis: any[] = []
  installPrisma(createFakePrisma({
    consentRecord: {
      findMany: async (a: any) => {
        seenBasis.push(a.where.basis)
        const keys = a.where.emailKey?.in ?? [a.where.emailKey]
        return rows.filter((r) => keys.includes(r.emailKey))
      },
      findFirst: async (a: any) => (a.where.basis.in.includes('express') ? { id: 'x' } : null),
    },
  }))
  assert.equal(await hasAuConsent('ws', 'GOOD@x.test'), true)
  assert.equal(await hasAuConsent('ws', 'thin@x.test'), false)
  assert.equal(await hasAuConsent('ws', 'none@x.test'), false)
  const check = await bulkCheckAuConsent('ws', ['good@x.test', 'thin@x.test'])
  assert.equal(check('Good@X.test'), true)
  assert.equal(check('thin@x.test'), false)
  assert.ok(seenBasis.every((b) => b.in.length === 2 && b.in.includes('express') && !b.in.includes('legitimate_interest')))
  // The legacy CASL/GDPR check must not accept AU bases (and vice versa).
  assert.equal(await hasConsent('ws', 'good@x.test'), false)
})

// ── send authorization ────────────────────────────────────────────────────────
function installWorkspace(ws: Record<string, unknown>, consentRows: any[] = []) {
  const db = createFakePrisma({
    workspace: { findUnique: async () => ({ sendSuppressed: false, lawfulBasis: null, targetsCanada: false, targetsAustralia: false, ...ws }) },
    consentRecord: { findMany: async () => consentRows, findFirst: async () => null },
    auditEvent: { create: async () => ({}) },
    suppression: { findUnique: async () => null, findMany: async () => [] },
    contactEvent: { findFirst: async () => null, count: async () => 0 },
    lead: { findUnique: async () => null },
  })
  installPrisma(db)
  return db
}

test('AU flag defaults OFF', () => {
  delete process.env.AU_COMMERCIAL_SENDING_ENABLED
  assert.equal(isAuCommercialSendingEnabled(), false)
})

test('AU workspace: campaign batch and follow-up are denied AU_SENDING_DISABLED while the flag is off (even with perfect evidence)', async () => {
  process.env.REPUTATION_GUARD_MODE = 'off'
  delete process.env.AU_COMMERCIAL_SENDING_ENABLED
  installWorkspace({ targetsAustralia: true }, [{ emailKey: 'a@x.test', ...express() }])
  const batch = await authorizeOutboundSend({ workspaceId: 'ws', context: 'campaign', recipientChecks: false })
  assert.equal(batch.allowed, false); assert.equal(batch.code, 'AU_SENDING_DISABLED')
  const fu = await authorizeOutboundSend({ workspaceId: 'ws', context: 'followup', email: 'a@x.test' })
  assert.equal(fu.allowed, false); assert.equal(fu.code, 'AU_SENDING_DISABLED')
})

test('AU workspace + flag on: no/invalid evidence → AU_CONSENT_REQUIRED; valid evidence passes only then', async () => {
  process.env.REPUTATION_GUARD_MODE = 'off'
  process.env.AU_COMMERCIAL_SENDING_ENABLED = 'true'
  installWorkspace({ targetsAustralia: true }, [])
  assert.equal((await authorizeOutboundSend({ workspaceId: 'ws', context: 'campaign', email: 'a@x.test' })).code, 'AU_CONSENT_REQUIRED')
  resetPrisma()
  installWorkspace({ targetsAustralia: true }, [{ emailKey: 'a@x.test', ...published({ roleRelevant: false }) }])
  assert.equal((await authorizeOutboundSend({ workspaceId: 'ws', context: 'followup', email: 'a@x.test' })).code, 'AU_CONSENT_REQUIRED')
  resetPrisma()
  installWorkspace({ targetsAustralia: true }, [{ emailKey: 'a@x.test', ...published() }])
  const ok = await authorizeOutboundSend({ workspaceId: 'ws', context: 'campaign', email: 'a@x.test' })
  assert.equal(ok.allowed, true)
})

test('AU workspace: lawfulBasis legitimate_interest never substitutes for AU consent', async () => {
  process.env.REPUTATION_GUARD_MODE = 'off'
  process.env.AU_COMMERCIAL_SENDING_ENABLED = 'true'
  process.env.COMPLIANCE_GATE_ENABLED = 'true'
  installWorkspace({ targetsAustralia: true, lawfulBasis: 'legitimate_interest' }, [])
  assert.equal((await authorizeOutboundSend({ workspaceId: 'ws', context: 'campaign', email: 'a@x.test' })).code, 'AU_CONSENT_REQUIRED')
})

test('non-AU workspaces are unaffected by the AU gate (flag off or on)', async () => {
  process.env.REPUTATION_GUARD_MODE = 'off'
  for (const flag of [undefined, 'true']) {
    if (flag) process.env.AU_COMMERCIAL_SENDING_ENABLED = flag; else delete process.env.AU_COMMERCIAL_SENDING_ENABLED
    installWorkspace({ targetsAustralia: false, lawfulBasis: 'legitimate_interest' }, [])
    assert.equal((await authorizeOutboundSend({ workspaceId: 'ws', context: 'campaign', email: 'a@x.test' })).allowed, true)
    resetPrisma()
  }
})

test('AU workspace: human replies (inbox) are not blocked by the commercial gate', async () => {
  process.env.REPUTATION_GUARD_MODE = 'off'
  delete process.env.AU_COMMERCIAL_SENDING_ENABLED
  installWorkspace({ targetsAustralia: true })
  const r = await authorizeOutboundSend({ workspaceId: 'ws', context: 'reply', email: 'a@x.test' }).catch((e) => e)
  assert.notEqual((r as any).code, 'AU_SENDING_DISABLED')
})
