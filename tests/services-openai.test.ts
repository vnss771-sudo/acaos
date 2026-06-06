import test from 'node:test'
import assert from 'node:assert/strict'
import { generateLeadResearch, generateOutreach, analyzeReply } from '../apps/api/src/services/openai.ts'
import { ApiError } from '../apps/api/src/lib/http.ts'

function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
  try {
    const result = fn()
    if (result && typeof (result as any).then === 'function') {
      return (result as Promise<void>).finally(restore)
    }
    restore()
    return result
  } catch (e) {
    restore()
    throw e
  }
}

// ---------------------------------------------------------------------------
// OpenAI service — unconfigured guard (no live API calls)
// ---------------------------------------------------------------------------
test('generateLeadResearch: throws ApiError 503 when OPENAI_API_KEY not set', async () => {
  await withEnv({ OPENAI_API_KEY: undefined }, async () => {
    await assert.rejects(
      () => generateLeadResearch({ businessName: 'Acme' }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError, 'should throw ApiError')
        assert.equal((err as ApiError).statusCode, 503)
        assert.match((err as ApiError).message, /not configured/i)
        return true
      }
    )
  })
})

test('generateOutreach: throws ApiError 503 when OPENAI_API_KEY not set', async () => {
  await withEnv({ OPENAI_API_KEY: undefined }, async () => {
    await assert.rejects(
      () => generateOutreach({ businessName: 'Acme' }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError)
        assert.equal((err as ApiError).statusCode, 503)
        return true
      }
    )
  })
})

test('analyzeReply: throws ApiError 503 when OPENAI_API_KEY not set', async () => {
  await withEnv({ OPENAI_API_KEY: undefined }, async () => {
    await assert.rejects(
      () => analyzeReply('Looks interesting, tell me more'),
      (err: unknown) => {
        assert.ok(err instanceof ApiError)
        assert.equal((err as ApiError).statusCode, 503)
        return true
      }
    )
  })
})

test('generateLeadResearch: does NOT throw the 503 when OPENAI_API_KEY is set (network will fail, not config guard)', async () => {
  await withEnv({ OPENAI_API_KEY: 'sk-test-fake-key' }, async () => {
    // Will throw a network/API error (not our 503 guard) — confirm it's not ApiError 503
    try {
      await generateLeadResearch({ businessName: 'Acme' })
    } catch (err: unknown) {
      if (err instanceof ApiError && (err as ApiError).statusCode === 503) {
        assert.fail('Should not throw 503 when API key is configured')
      }
      // Any other error (network, OpenAI auth) is expected — key guard passed
    }
  })
})
