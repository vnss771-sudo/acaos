import test from 'node:test'
import assert from 'node:assert/strict'
import { toIcpContext, buildVerticalDesc } from '../packages/backend-core/src/services/openai.ts'

test('toIcpContext maps a WorkspaceICP record (null → undefined)', () => {
  const ctx = toIcpContext({ targetIndustries: ['SaaS', 'Fintech'], businessType: 'B2B software', outreachTone: 'direct' })
  assert.deepEqual(ctx, { targetIndustries: ['SaaS', 'Fintech'], businessType: 'B2B software', outreachTone: 'direct' })
})

test('toIcpContext returns undefined when no ICP is configured', () => {
  assert.equal(toIcpContext(null), undefined)
  assert.equal(toIcpContext(undefined), undefined)
})

test('toIcpContext coerces null DB fields to undefined', () => {
  const ctx = toIcpContext({ targetIndustries: [], businessType: null, outreachTone: null })
  assert.equal(ctx?.businessType, undefined)
  assert.equal(ctx?.outreachTone, undefined)
})

test('the mapped ICP drives the prompt vertical (not the field-service default)', () => {
  // Regression guard for the wrong-vertical bug: a SaaS workspace must not get a
  // plumbing/HVAC-framed prompt.
  const vertical = buildVerticalDesc(toIcpContext({ targetIndustries: ['SaaS companies'] }))
  assert.equal(vertical, 'SaaS companies')
  assert.ok(!buildVerticalDesc(toIcpContext({ targetIndustries: ['SaaS companies'] })).includes('plumbing'))
  // No ICP → the documented field-service default still applies.
  assert.ok(buildVerticalDesc(undefined).includes('plumbing'))
})
