import test from 'node:test'
import assert from 'node:assert/strict'
import { clampInt } from '../apps/api/src/lib/validation.ts'

const opts = { min: 1, max: 100, fallback: 25 }

test('clampInt: returns the value when within range', () => {
  assert.equal(clampInt('50', opts), 50)
  assert.equal(clampInt(50, opts), 50)
})

test('clampInt: clamps below min and above max (no negative/zero/oversized take)', () => {
  assert.equal(clampInt('-100', opts), 1, 'negative would reverse Prisma ordering')
  assert.equal(clampInt('0', opts), 1)
  assert.equal(clampInt('100000', opts), 100)
})

test('clampInt: falls back on NaN / non-numeric / missing input', () => {
  assert.equal(clampInt('abc', opts), 25)
  assert.equal(clampInt('', opts), 25)
  assert.equal(clampInt(undefined, opts), 25)
  assert.equal(clampInt(null, opts), 25)
  assert.equal(clampInt(NaN, opts), 25)
})

test('clampInt: truncates fractional input', () => {
  assert.equal(clampInt('25.9', opts), 25)
})
