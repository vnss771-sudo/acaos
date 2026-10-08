// Final-wire regression tests for OpenAI request compatibility.
// These intentionally exercise the real OpenAI SDK against a local HTTP server
// and assert the JSON body that ACAOS sends over the wire. Helper-only tests are
// not sufficient: the GPT-5 temperature regression existed even while the token
// and reasoning helper tests were green.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { generateLeadResearch } from '../packages/backend-core/src/services/openai.ts'

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
