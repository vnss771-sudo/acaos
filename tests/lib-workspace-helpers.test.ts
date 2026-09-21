// Unit tests for apps/api/src/routes/workspaces/helpers.ts's pure functions —
// previously only exercised indirectly through route tests using mocked data,
// with no direct coverage of either function's own branches.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateMailPort, seededScore } from '../apps/api/src/routes/workspaces/helpers.ts'
import { ApiError } from '../packages/backend-core/src/lib/errors.ts'

test('validateMailPort: a null/undefined/0 port is not validated (field is optional)', () => {
  validateMailPort(undefined, [587, 465], 'smtpPort')
  validateMailPort(null, [587, 465], 'smtpPort')
  validateMailPort(0, [587, 465], 'smtpPort')
})

test('validateMailPort: an allowed port passes without throwing', () => {
  validateMailPort(587, [587, 465], 'smtpPort')
})

test('validateMailPort: a disallowed port throws an ApiError naming the field and allowed list', () => {
  assert.throws(
    () => validateMailPort(25, [587, 465], 'smtpPort'),
    (err: unknown) => {
      assert.ok(err instanceof ApiError)
      assert.equal(err.statusCode, 400)
      assert.match(err.message, /smtpPort/)
      assert.match(err.message, /25/)
      assert.match(err.message, /587, 465/)
      return true
    },
  )
})

test('seededScore: deterministic for the same inputs (no Math.random)', () => {
  const a = seededScore('Acme Corp', 7, 100, 0)
  const b = seededScore('Acme Corp', 7, 100, 0)
  assert.equal(a, b)
})

test('seededScore: always falls within [base, base + range)', () => {
  for (const name of ['A', 'Acme Corp', 'A Very Long Company Name Pty Ltd', '']) {
    const score = seededScore(name, 42, 50, 10)
    assert.ok(score >= 10 && score < 60, `expected ${score} in [10, 60) for "${name}"`)
  }
})

test('seededScore: different company names produce different salts in the hash (not a constant)', () => {
  const a = seededScore('Acme Corp', 7, 1000, 0)
  const b = seededScore('Zenith Industries', 7, 1000, 0)
  assert.notEqual(a, b, 'two distinct names collapsing to the same score would defeat the point of seeding on the name')
})
