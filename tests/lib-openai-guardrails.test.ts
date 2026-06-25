import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { clampNotes, clampTokens, model, buildOutreachUserPrompt } from '../packages/backend-core/src/services/openai.ts'

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

test('model: allow-lists known-cheap models, falls back to default otherwise', () => {
  delete process.env.OPENAI_MODEL
  assert.equal(model(), 'gpt-4o-mini')                  // default when unset
  process.env.OPENAI_MODEL = 'gpt-4o'
  assert.equal(model(), 'gpt-4o')                       // allow-listed honored
  process.env.OPENAI_MODEL = 'gpt-4-turbo-expensive'
  assert.equal(model(), 'gpt-4o-mini')                  // unrecognized → default
})

test('buildOutreachUserPrompt: long notes are truncated before entering the prompt', () => {
  const note = 'SECRET ' + 'a'.repeat(900)
  const prompt = buildOutreachUserPrompt({ businessName: 'Acme', notes: note })
  assert.ok(prompt.includes('SECRET'))           // the real connection still opens the email
  assert.ok(!prompt.includes('a'.repeat(900)))   // but the full unbounded value never reaches the model
})
