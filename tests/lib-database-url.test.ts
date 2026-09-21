// Pure unit tests for the connection_limit URL-construction logic prisma.ts
// uses to pin a bounded Postgres pool per process (R4 follow-up: enforce, not
// just warn, when the operator hasn't set connection_limit themselves).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withDefaultConnectionLimit, DEFAULT_CONNECTION_LIMIT } from '../packages/backend-core/src/lib/databaseUrl.ts'

test('appends the default connection_limit when the URL has no query string', () => {
  const result = withDefaultConnectionLimit('postgresql://user:pass@host:5432/db', {})
  assert.equal(result, `postgresql://user:pass@host:5432/db?connection_limit=${DEFAULT_CONNECTION_LIMIT}`)
})

test('appends with & when the URL already has other query params', () => {
  const result = withDefaultConnectionLimit('postgresql://user:pass@host:5432/db?schema=public', {})
  assert.equal(result, `postgresql://user:pass@host:5432/db?schema=public&connection_limit=${DEFAULT_CONNECTION_LIMIT}`)
})

test('never overrides an operator-set connection_limit', () => {
  const url = 'postgresql://user:pass@host:5432/db?connection_limit=42'
  assert.equal(withDefaultConnectionLimit(url, {}), url)
})

test('respects an operator-set connection_limit regardless of position in the query string', () => {
  const url = 'postgresql://user:pass@host:5432/db?pool_timeout=20&connection_limit=7&schema=public'
  assert.equal(withDefaultConnectionLimit(url, {}), url)
})

test('uses DB_POOL_SIZE when set and valid', () => {
  const result = withDefaultConnectionLimit('postgresql://h/db', { DB_POOL_SIZE: '25' })
  assert.equal(result, 'postgresql://h/db?connection_limit=25')
})

test('falls back to the default when DB_POOL_SIZE is not a positive number', () => {
  for (const bad of ['0', '-5', 'not-a-number', '']) {
    const result = withDefaultConnectionLimit('postgresql://h/db', { DB_POOL_SIZE: bad })
    assert.equal(result, `postgresql://h/db?connection_limit=${DEFAULT_CONNECTION_LIMIT}`, `DB_POOL_SIZE=${JSON.stringify(bad)}`)
  }
})

test('truncates a fractional DB_POOL_SIZE down to an integer', () => {
  const result = withDefaultConnectionLimit('postgresql://h/db', { DB_POOL_SIZE: '12.9' })
  assert.equal(result, 'postgresql://h/db?connection_limit=12')
})

test('passes through an empty/undefined URL unchanged', () => {
  assert.equal(withDefaultConnectionLimit('', {}), '')
})

test('defaults to process.env when no env object is passed', () => {
  const prev = process.env.DB_POOL_SIZE
  delete process.env.DB_POOL_SIZE
  try {
    const result = withDefaultConnectionLimit('postgresql://h/db')
    assert.equal(result, `postgresql://h/db?connection_limit=${DEFAULT_CONNECTION_LIMIT}`)
  } finally {
    if (prev === undefined) delete process.env.DB_POOL_SIZE
    else process.env.DB_POOL_SIZE = prev
  }
})
