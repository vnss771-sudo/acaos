import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

test('doctor script runs and reports the project summary without external services', () => {
  const result = spawnSync('node', ['scripts/doctor.mjs'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /ACAOS project doctor/)
  assert.match(result.stdout, /Node\.js runtime/)
  assert.match(result.stdout, /Next useful gates/)
})
