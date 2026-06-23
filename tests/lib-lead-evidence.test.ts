import test from 'node:test'
import assert from 'node:assert/strict'
import { mapEvidenceToRows } from '../packages/backend-core/src/lib/leadEvidence.ts'

test('mapEvidenceToRows: maps a confirmed item and keeps its source URL', () => {
  const [row] = mapEvidenceToRows([
    { signal: 'Website lists 4 service areas', type: 'confirmed', confidence: 'high', sourceUrl: 'https://acme.example/services' },
  ])
  assert.equal(row.evidenceType, 'confirmed')
  assert.equal(row.confidence, 'high')
  assert.equal(row.sourceUrl, 'https://acme.example/services')
  assert.equal(row.sourceType, 'website')
  assert.equal(row.provider, 'llm-research')
})

test('mapEvidenceToRows: drops the source URL for non-confirmed items', () => {
  const [row] = mapEvidenceToRows([
    { signal: 'Likely dispatch complexity', type: 'inferred', confidence: 'medium', sourceUrl: 'https://made.up/url' },
  ])
  assert.equal(row.evidenceType, 'inferred')
  assert.equal(row.sourceUrl, null)
  assert.equal(row.sourceType, 'inference')
})

test('mapEvidenceToRows: observed items map to a notes source type', () => {
  const [row] = mapEvidenceToRows([{ signal: 'Has a careers page', type: 'observed', confidence: 'low' }])
  assert.equal(row.evidenceType, 'observed')
  assert.equal(row.sourceType, 'notes')
})

test('mapEvidenceToRows: unknown type/confidence degrade to the weakest tier', () => {
  // Bad values can only arrive if upstream validation is bypassed; degrade safely.
  const [row] = mapEvidenceToRows([{ signal: 'x', type: 'rumour' as never, confidence: 'certain' as never }])
  assert.equal(row.evidenceType, 'inferred')
  assert.equal(row.confidence, 'low')
})

test('mapEvidenceToRows: drops empty-signal items and tolerates undefined', () => {
  assert.deepEqual(mapEvidenceToRows(undefined), [])
  assert.deepEqual(mapEvidenceToRows(null), [])
  const rows = mapEvidenceToRows([
    { signal: '   ', type: 'observed', confidence: 'low' },
    { signal: 'real one', type: 'observed', confidence: 'low' },
  ])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].signal, 'real one')
})

test('mapEvidenceToRows: caps at 20 rows', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ signal: `s${i}`, type: 'inferred' as const, confidence: 'low' as const }))
  assert.equal(mapEvidenceToRows(many).length, 20)
})
