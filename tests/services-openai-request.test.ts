// Final-wire regression tests for OpenAI request compatibility.
// These intentionally exercise the real OpenAI SDK against a local HTTP server
// and assert the JSON body that ACAOS sends over the wire. Helper-only tests are
// not sufficient: the GPT-5 temperature regression existed even while the token
// and reasoning helper tests were green.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { generateLeadResearch, setShadowComparisonObserver, setAiProviderCallObserver, type ShadowComparison, type AiProviderCallMeta } from '../packages/backend-core/src/services/openai.ts'

type JsonObject = Record<string, unknown>

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await fn()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

async function captureRequest(model: string): Promise<JsonObject> {
  let body: JsonObject | null = null
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonObject
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        id: 'mock-completion',
        object: 'chat.completion',
        created: 1,
        model,
        choices: [{
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: '{"ok":true}' },
        }],
      }))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  try {
    await withEnv({
      OPENAI_API_KEY: 'mock-key',
      OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      OPENAI_API_BASE: undefined,
      OPENAI_MODEL: model,
    }, async () => {
      await generateLeadResearch({ businessName: 'Wire Test Electrical' })
    })
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
  }

  assert.ok(body, 'mock provider should capture one request body')
  return body
}

for (const model of ['gpt-5-mini', 'gpt-5-nano']) {
  test(`${model}: final request uses reasoning-compatible fields and omits temperature`, async () => {
    const request = await captureRequest(model)
    assert.equal(request.model, model)
    assert.equal(typeof request.max_completion_tokens, 'number')
    assert.equal(request.reasoning_effort, 'low')
    assert.ok(!('temperature' in request), 'reasoning request must not send temperature')
    assert.ok(!('max_tokens' in request), 'reasoning request must not send legacy max_tokens')
  })
}

test('o4-mini: final request uses max_completion_tokens and omits sampling temperature', async () => {
  const request = await captureRequest('o4-mini')
  assert.equal(request.model, 'o4-mini')
  assert.equal(typeof request.max_completion_tokens, 'number')
  assert.ok(!('temperature' in request))
  assert.ok(!('max_tokens' in request))
  assert.ok(!('reasoning_effort' in request), 'ACAOS does not force an effort setting on o-series')
})

test('gpt-4o-mini: final request retains temperature and legacy token field', async () => {
  const request = await captureRequest('gpt-4o-mini')
  assert.equal(request.model, 'gpt-4o-mini')
  assert.equal(request.temperature, 0.4)
  assert.equal(typeof request.max_tokens, 'number')
  assert.ok(!('max_completion_tokens' in request))
  assert.ok(!('reasoning_effort' in request))
})

// ── Shadow evaluation (UQ-19) ────────────────────────────────────────────────
// A provider that answers per model; the shadow model can be made to fail.
async function withProvider<T>(opts: { failModel?: string }, fn: (port: number, seen: string[]) => Promise<T>): Promise<T> {
  const seen: string[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string }
      seen.push(body.model)
      if (body.model === opts.failModel) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'shadow down' } }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        id: 'mock', object: 'chat.completion', created: 1, model: body.model,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ summary: `from ${body.model}` }) } }],
      }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    return await fn((server.address() as AddressInfo).port, seen)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
  }
}

function shadowEnv(port: number, rate: string) {
  return {
    OPENAI_API_KEY: 'mock-key', OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`, OPENAI_API_BASE: undefined,
    OPENAI_MODEL: 'gpt-4o-mini', OPENAI_SHADOW_MODEL: 'gpt-5-mini', OPENAI_SHADOW_SAMPLE_RATE: rate,
  }
}

function nextShadowComparison(): Promise<ShadowComparison> {
  return new Promise((resolve) => setShadowComparisonObserver((c) => { setShadowComparisonObserver(undefined); resolve(c) }))
}

test('shadow at rate 1: both models get the request, the caller only ever sees the active output', async () => {
  await withProvider({}, async (port, seen) => {
    const calls: AiProviderCallMeta[] = []
    setAiProviderCallObserver((m) => calls.push(m))
    const comparison = nextShadowComparison()
    try {
      const result = await withEnv(shadowEnv(port, '1'), () => generateLeadResearch({ businessName: 'Shadow Test Electrical' }))
      assert.match(JSON.stringify(result), /from gpt-4o-mini/)
      assert.doesNotMatch(JSON.stringify(result), /gpt-5-mini/)
      const c = await comparison
      assert.deepEqual(seen.sort(), ['gpt-4o-mini', 'gpt-5-mini'])
      assert.equal(c.activeModel, 'gpt-4o-mini')
      assert.equal(c.shadowModel, 'gpt-5-mini')
      assert.equal(c.shadowOk, true)
      assert.equal(c.sameOutput, false)
      assert.match(c.shadowOutputHash ?? '', /^[0-9a-f]{64}$/)
      assert.ok(!JSON.stringify(c).includes('Shadow Test Electrical'), 'no prompt content in the comparison')
      assert.deepEqual(calls.map(m => [m.model, m.deploymentState]), [['gpt-4o-mini', 'ACTIVE']], 'only the active call is reported as a provider call')
    } finally {
      setAiProviderCallObserver(undefined)
      setShadowComparisonObserver(undefined)
    }
  })
})

test('a failing shadow model cannot fail or replace the active result', async () => {
  await withProvider({ failModel: 'gpt-5-mini' }, async (port, seen) => {
    const comparison = nextShadowComparison()
    const result = await withEnv(shadowEnv(port, '1'), () => generateLeadResearch({ businessName: 'Shadow Failure Plumbing' }))
    assert.match(JSON.stringify(result), /from gpt-4o-mini/)
    const c = await comparison
    assert.equal(c.shadowOk, false)
    assert.equal(c.shadowOutputHash, null)
    assert.equal(seen.filter(m => m === 'gpt-5-mini').length, 1, 'the shadow is not retried')
  })
})

test('shadow at the default rate 0 sends nothing to the shadow model', async () => {
  await withProvider({}, async (port, seen) => {
    await withEnv({ ...shadowEnv(port, '0') }, () => generateLeadResearch({ businessName: 'No Shadow Roofing' }))
    await new Promise((r) => setTimeout(r, 50))
    assert.deepEqual(seen, ['gpt-4o-mini'])
  })
})
