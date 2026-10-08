import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { clampNotes, clampTokens, model, buildOutreachUserPrompt, tokenLimitOptions, reasoningOptions, isReasoningModel, samplingOptions } from '../packages/backend-core/src/services/openai.ts'

const savedModel = process.env.OPENAI_MODEL
afterEach(() => {
  if (savedModel === undefined) delete process.env.OPENAI_MODEL
  else process.env.OPENAI_MODEL = savedModel
})

test('clampNotes: empty/whitespace → undefined; short note preserved', () => {
  assert.equal(clampNotes(undefined), undefined)
  assert.equal(clampNotes('   '), undefined)
  assert.equal(clampNotes('met at the trade show'), 'met at the trade show')
})

test('clampNotes: truncates PII-bearing notes over 500 chars (caps token + leak)', () => {
  const long = 'x'.repeat(900)
  const out = clampNotes(long)!
  assert.ok(out.length <= 501) // 500 + ellipsis
  assert.ok(out.endsWith('…'))
})

test('clampTokens: honors a valid override but enforces the hard 4000 ceiling', () => {
  assert.equal(clampTokens('1200', 1200), 1200)
  assert.equal(clampTokens(undefined, 1500), 1500)      // default when unset
  assert.equal(clampTokens('not-a-number', 700), 700)   // default when invalid
  assert.equal(clampTokens('0', 700), 700)              // non-positive → default
  assert.equal(clampTokens('1000000', 1500), 4000)      // runaway value clamped
})

test('model: uses the supported low-cost default and falls back for unknown models', () => {
  delete process.env.OPENAI_MODEL
  assert.equal(model(), 'gpt-5-mini')                   // default when unset
  process.env.OPENAI_MODEL = 'gpt-5-mini'
  assert.equal(model(), 'gpt-5-mini')                   // current low-cost reasoning model
  process.env.OPENAI_MODEL = 'gpt-4o'
  assert.equal(model(), 'gpt-4o')                       // allow-listed honored
  process.env.OPENAI_MODEL = 'gpt-4-turbo-expensive'
  assert.equal(model(), 'gpt-5-mini')                   // unrecognized → default
})



test('model compatibility helpers: reasoning families suppress temperature', () => {
  for (const name of ['gpt-5-mini', 'gpt-5-nano', 'gpt-5.5', 'o4-mini']) {
    assert.equal(isReasoningModel(name), true, `${name} should be a reasoning family`)
    assert.deepEqual(samplingOptions(name), {}, `${name} must not receive temperature`)
  }
  assert.equal(isReasoningModel('gpt-4o-mini'), false)
  assert.deepEqual(samplingOptions('gpt-4o-mini'), { temperature: 0.4 })
})

test('tokenLimitOptions: reasoning models use max_completion_tokens', () => {
  assert.deepEqual(tokenLimitOptions('gpt-5-mini', 1200), { max_completion_tokens: 1200 })
  assert.deepEqual(tokenLimitOptions('gpt-5.5', 800), { max_completion_tokens: 800 })
  assert.deepEqual(tokenLimitOptions('o4-mini', 700), { max_completion_tokens: 700 })
})

test('tokenLimitOptions: standard chat models retain max_tokens', () => {
  assert.deepEqual(tokenLimitOptions('gpt-4o-mini', 1200), { max_tokens: 1200 })
})

test('reasoningOptions: GPT-5 uses minimal reasoning on the Manus proxy and low on standard OpenAI', () => {
  assert.deepEqual(reasoningOptions('gpt-5-mini', 'https://api.manus.im/api/llm-proxy/v1'), { reasoning: { effort: 'minimal' } })
  assert.deepEqual(reasoningOptions('gpt-5-mini', 'https://api.openai.com/v1'), { reasoning_effort: 'low' })
  assert.deepEqual(reasoningOptions('gpt-4o-mini', 'https://api.openai.com/v1'), {})
})

test('buildOutreachUserPrompt: long notes are truncated before entering the prompt', () => {
  const note = 'SECRET ' + 'a'.repeat(900)
  const prompt = buildOutreachUserPrompt({ businessName: 'Acme', notes: note })
  assert.ok(prompt.includes('SECRET'))           // the real connection still opens the email
  assert.ok(!prompt.includes('a'.repeat(900)))   // but the full unbounded value never reaches the model
})
