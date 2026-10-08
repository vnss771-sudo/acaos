// Unit tests for the outreach generation provenance descriptor (pure, env-driven).
// The DB-backed registry (resolvePromptVersionId) is covered in the DB tier.

import test from 'node:test'
import assert from 'node:assert/strict'
import { outreachGenerationMeta, OUTREACH_PROMPT_VERSION } from '../packages/backend-core/src/services/openai.ts'

function restore(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

test('standard model provenance records the sampling params actually sent', () => {
  const savedModel = process.env.OPENAI_MODEL
  const savedBase = process.env.OPENAI_BASE_URL
  try {
    process.env.OPENAI_MODEL = 'gpt-4o-mini'
    process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
    const a = outreachGenerationMeta()
    assert.equal(a.type, 'OUTREACH')
    assert.equal(a.model, 'gpt-4o-mini')
    assert.equal(a.temperature, 0.4)
    assert.equal(a.metadata.tokenParameter, 'max_tokens')
    assert.equal(a.metadata.reasoningEffort, null)
    assert.ok(a.maxTokens > 0)
    assert.match(a.promptHash, /^[0-9a-f]{64}$/, 'sha-256 hex')
    assert.equal(outreachGenerationMeta().promptHash, a.promptHash, 'same wire config should hash identically')
  } finally {
    restore('OPENAI_MODEL', savedModel)
    restore('OPENAI_BASE_URL', savedBase)
  }
})

test('reasoning model provenance omits temperature and records reasoning/token settings', () => {
  const savedModel = process.env.OPENAI_MODEL
  const savedBase = process.env.OPENAI_BASE_URL
  try {
    process.env.OPENAI_MODEL = 'gpt-5-mini'
    process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
    const meta = outreachGenerationMeta()
    assert.equal(meta.temperature, null)
    assert.equal(meta.metadata.tokenParameter, 'max_completion_tokens')
    assert.equal(meta.metadata.reasoningEffort, 'low')
  } finally {
    restore('OPENAI_MODEL', savedModel)
    restore('OPENAI_BASE_URL', savedBase)
  }
})

test('promptHash changes when the effective model/request config changes', () => {
  const savedModel = process.env.OPENAI_MODEL
  const savedBase = process.env.OPENAI_BASE_URL
  try {
    process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
    process.env.OPENAI_MODEL = 'gpt-4o-mini'
    const standard = outreachGenerationMeta().promptHash
    process.env.OPENAI_MODEL = 'gpt-5-mini'
    const reasoning = outreachGenerationMeta().promptHash
    assert.notEqual(standard, reasoning, 'a model/request-profile swap is a distinct prompt version')
  } finally {
    restore('OPENAI_MODEL', savedModel)
    restore('OPENAI_BASE_URL', savedBase)
  }
})

test('the prompt version constant is a positive integer', () => {
  assert.ok(Number.isInteger(OUTREACH_PROMPT_VERSION) && OUTREACH_PROMPT_VERSION >= 1)
})
