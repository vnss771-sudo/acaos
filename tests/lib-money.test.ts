import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dollarsToCents, centsToDollars } from '../apps/api/src/lib/money.ts'

test('dollarsToCents rounds to the nearest cent', () => {
  assert.equal(dollarsToCents(5000), 500000)
  assert.equal(dollarsToCents(12.34), 1234)
  assert.equal(dollarsToCents(0.1), 10)
  assert.equal(dollarsToCents(12.345), 1235) // rounds half up
})

test('centsToDollars converts back, preserving null', () => {
  assert.equal(centsToDollars(500000), 5000)
  assert.equal(centsToDollars(1234), 12.34)
  assert.equal(centsToDollars(null), null)
  assert.equal(centsToDollars(undefined), null)
})

test('round-trips whole-cent amounts exactly', () => {
  for (const d of [0, 1, 99.99, 5000, 1234567.89]) {
    assert.equal(centsToDollars(dollarsToCents(d)), d)
  }
})
