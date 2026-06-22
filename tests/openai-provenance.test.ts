// Unit tests for the outreach generation provenance descriptor (pure, env-driven).
// The DB-backed registry (resolvePromptVersionId) is covered in the DB tier.

import test from 'node:test'
import assert from 'node:assert/strict'
import { outreachGenerationMeta, OUTREACH_PROMPT_VERSION } from '../packages/backend-core/src/services/openai.ts'

test('meta records the active model, params, and a stable promptHash', () => {
  const saved = process.env.OPENAI_MODEL
  try {
    process.env.OPENAI_MODEL = 'gpt-4o-mini'
    const a = outreachGenerationMeta()
    assert.equal(a.type, 'OUTREACH')
    assert.equal(a.model, 'gpt-4o-mini')
    assert.equal(typeof a.temperature, 'number')
    assert.ok(a.maxTokens > 0)
    assert.match(a.promptHash, /^[0-9a-f]{64}$/, 'sha-256 hex')
    // Deterministic for the same config.
    assert.equal(outreachGenerationMeta().promptHash, a.promptHash)
  } finally {
    if (saved === undefined) delete process.env.OPENAI_MODEL
    else process.env.OPENAI_MODEL = saved
  }
})

test('promptHash changes when the model changes', () => {
  const saved = process.env.OPENAI_MODEL
  try {
    process.env.OPENAI_MODEL = 'gpt-4o-mini'
    const a = outreachGenerationMeta().promptHash
    process.env.OPENAI_MODEL = 'gpt-4o'
    const b = outreachGenerationMeta().promptHash
    assert.notEqual(a, b, 'a model swap is a distinct prompt version')
  } finally {
    if (saved === undefined) delete process.env.OPENAI_MODEL
    else process.env.OPENAI_MODEL = saved
  }
})

test('the prompt version constant is a positive integer', () => {
  assert.ok(Number.isInteger(OUTREACH_PROMPT_VERSION) && OUTREACH_PROMPT_VERSION >= 1)
})
