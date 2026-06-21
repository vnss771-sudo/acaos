import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTrustProxy } from '../apps/api/src/lib/trustProxy.ts'

test('defaults to a single proxy hop when unset/blank', () => {
  assert.equal(parseTrustProxy(undefined), 1)
  assert.equal(parseTrustProxy(''), 1)
  assert.equal(parseTrustProxy('   '), 1)
})

test('parses booleans', () => {
  assert.equal(parseTrustProxy('true'), true)
  assert.equal(parseTrustProxy('false'), false)
})

test('parses a non-negative hop count as a number', () => {
  assert.equal(parseTrustProxy('0'), 0)
  assert.equal(parseTrustProxy('2'), 2)
})

test('passes through a subnet/keyword spec verbatim', () => {
  assert.equal(parseTrustProxy('loopback'), 'loopback')
  assert.equal(parseTrustProxy('10.0.0.0/8, 127.0.0.1'), '10.0.0.0/8, 127.0.0.1')
})

test('a negative or non-integer number is treated as a passthrough spec, not a hop count', () => {
  // -1 / 1.5 are not valid hop counts; keep them verbatim rather than silently
  // coercing to a surprising trust depth.
  assert.equal(parseTrustProxy('-1'), '-1')
  assert.equal(parseTrustProxy('1.5'), '1.5')
})
