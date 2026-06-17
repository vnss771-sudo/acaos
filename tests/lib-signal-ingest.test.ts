// Unit tests for the unified signal ingestion service.
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createFakePrisma, installPrisma, resetPrisma } from './helpers/integration.ts'
import { ingestSignal, buildSignalFingerprint } from '../apps/api/src/lib/signalIngest.ts'

afterEach(() => resetPrisma())

test('buildSignalFingerprint is deterministic and month-stable', () => {
  const a = buildSignalFingerprint('apollo', 'HIRING', '3 open positions', new Date('2026-06-01'))
  const b = buildSignalFingerprint('apollo', 'HIRING', '3 open positions', new Date('2026-06-28'))
  assert.equal(a, b) // same month → same fingerprint (idempotent within a month)
  assert.match(a, /^apollo:HIRING:3-open-positions:2026-06$/)
  const c = buildSignalFingerprint('apollo', 'HIRING', '3 open positions', new Date('2026-07-01'))
  assert.notEqual(a, c) // different month → distinct
})

test('ingestSignal creates an EvidenceSource and links it when evidence is given', async () => {
  const fake = createFakePrisma({
    evidenceSource: { create: async () => ({ id: 'ev1' }) },
    signal: { upsert: async (a: any) => ({ id: 'sig1', ...a.create }) },
  })
  installPrisma(fake)

  const sig = await ingestSignal({
    workspaceId: 'w', prospectId: 'p', type: 'HIRING', strength: 60, source: 'apollo',
    title: '3 open positions',
    evidence: { provider: 'apollo', sourceType: 'enrichment', confidence: 0.8 },
  })

  assert.equal(fake.callsTo('evidenceSource', 'create').length, 1)
  const upsertArg = fake.callsTo('signal', 'upsert')[0].args[0] as any
  assert.equal(upsertArg.create.evidenceSourceId, 'ev1')
  assert.match(upsertArg.where.prospectId_fingerprint.fingerprint, /^apollo:HIRING:/)
  assert.equal(sig.evidenceSourceId, 'ev1')
})

test('ingestSignal skips EvidenceSource when no evidence is given', async () => {
  const fake = createFakePrisma({
    evidenceSource: { create: async () => ({ id: 'should-not-be-called' }) },
    signal: { upsert: async (a: any) => ({ id: 'sig2', ...a.create }) },
  })
  installPrisma(fake)

  await ingestSignal({ workspaceId: 'w', prospectId: 'p', type: 'FUNDING', strength: 85, source: 'manual' })

  assert.equal(fake.callsTo('evidenceSource', 'create').length, 0)
  const upsertArg = fake.callsTo('signal', 'upsert')[0].args[0] as any
  assert.equal(upsertArg.create.evidenceSourceId, null)
})

test('ingestSignal clamps evidence confidence into [0,1]', async () => {
  const captured: any[] = []
  const fake = createFakePrisma({
    evidenceSource: { create: async (a: any) => { captured.push(a.data); return { id: 'ev' } } },
    signal: { upsert: async (a: any) => ({ id: 's', ...a.create }) },
  })
  installPrisma(fake)

  await ingestSignal({
    workspaceId: 'w', prospectId: 'p', type: 'HIRING', strength: 50, source: 'apollo',
    evidence: { provider: 'apollo', sourceType: 'enrichment', confidence: 5 }, // out of range
  })
  assert.equal(captured[0].confidence, 1)
})
