import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveModelRegistry, parseSampleRate, inShadowSample } from '../packages/backend-core/src/lib/modelRegistry.ts'
import { DEFAULT_OPENAI_MODEL } from '../packages/backend-core/src/lib/modelProfiles.ts'

test('with no configuration the built-in default is ACTIVE and nothing is shadowed', () => {
  const r = resolveModelRegistry({})
  assert.equal(r.active.model, DEFAULT_OPENAI_MODEL)
  assert.equal(r.active.state, 'ACTIVE')
  assert.equal(r.shadow, null)
  assert.equal(r.fallback, null)
  assert.deepEqual(r.disabled, [])
})

test('OPENAI_MODEL stays the ACTIVE selector; a model outside the allow-list is DISABLED and the default serves', () => {
  assert.equal(resolveModelRegistry({ OPENAI_MODEL: 'gpt-4o-mini' }).active.model, 'gpt-4o-mini')
  const blocked = resolveModelRegistry({ OPENAI_MODEL: 'gpt-9-ultra' })
  assert.equal(blocked.active.model, DEFAULT_OPENAI_MODEL)
  assert.equal(blocked.disabled[0].model, 'gpt-9-ultra')
  assert.match(blocked.disabled[0].reason ?? '', /OPENAI_MODEL_ALLOWLIST/)
  assert.equal(resolveModelRegistry({ OPENAI_MODEL: 'gpt-9-ultra', OPENAI_MODEL_ALLOWLIST: 'gpt-9-ultra' }).active.model, 'gpt-9-ultra')
})

test('a shadow model is deployed only when allow-listed and given a positive sample rate', () => {
  const on = resolveModelRegistry({ OPENAI_MODEL: 'gpt-4o-mini', OPENAI_SHADOW_MODEL: 'gpt-5-mini', OPENAI_SHADOW_SAMPLE_RATE: '0.25' })
  assert.equal(on.shadow?.model, 'gpt-5-mini')
  assert.equal(on.shadow?.state, 'SHADOW')
  assert.equal(on.shadow?.sampleRate, 0.25)
  assert.equal(on.shadow?.profile.tokenParameter, 'max_completion_tokens')

  const off = resolveModelRegistry({ OPENAI_SHADOW_MODEL: 'gpt-4o-mini' })
  assert.equal(off.shadow, null, 'sample rate defaults to 0')
  assert.equal(off.disabled[0].reason, 'OPENAI_SHADOW_SAMPLE_RATE is 0')
  assert.equal(resolveModelRegistry({ OPENAI_SHADOW_MODEL: 'nope-1', OPENAI_SHADOW_SAMPLE_RATE: '1' }).shadow, null)
  assert.equal(resolveModelRegistry({ OPENAI_MODEL: 'gpt-4o-mini', OPENAI_SHADOW_MODEL: 'gpt-4o-mini', OPENAI_SHADOW_SAMPLE_RATE: '1' }).shadow, null, 'shadowing the active model is pointless')
})

test('the fallback model is recorded but never becomes active', () => {
  const r = resolveModelRegistry({ OPENAI_MODEL: 'gpt-5-mini', OPENAI_FALLBACK_MODEL: 'gpt-4o-mini' })
  assert.equal(r.fallback?.state, 'FALLBACK')
  assert.equal(r.fallback?.model, 'gpt-4o-mini')
  assert.equal(r.active.model, 'gpt-5-mini')
})

test('sample rates outside 0..1 or malformed are off, and sampling is deterministic', () => {
  for (const raw of [undefined, '', 'abc', '-0.1', '1.5', 'NaN']) assert.equal(parseSampleRate(raw), 0, String(raw))
  assert.equal(parseSampleRate('0.5'), 0.5)
  assert.equal(inShadowSample(0, 'sys', 'user'), false)
  assert.equal(inShadowSample(1, 'sys', 'user'), true)
  const first = inShadowSample(0.5, 'sys', 'user-a')
  for (let i = 0; i < 5; i++) assert.equal(inShadowSample(0.5, 'sys', 'user-a'), first)
  const sampled = Array.from({ length: 400 }, (_, i) => inShadowSample(0.25, 'sys', `user-${i}`)).filter(Boolean).length
  assert.ok(sampled > 60 && sampled < 140, `~25% sampled, got ${sampled}/400`)
})
