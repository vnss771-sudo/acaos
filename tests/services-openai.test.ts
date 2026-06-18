import test from 'node:test'
import assert from 'node:assert/strict'
import { generateLeadResearch, generateOutreach, analyzeReply, buildOutreachUserPrompt } from '../packages/backend-core/src/services/openai.ts'
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

// ---------------------------------------------------------------------------
// Outreach prompt — prospect industry must come from the prospect, never the
// seller's ICP. Regression for "Acme Plumbing … scaling in the manufacturing
// sector" (the outreach leaked the workspace ICP's first industry).
// ---------------------------------------------------------------------------
test('buildOutreachUserPrompt: never asserts the seller ICP industry as the prospect industry', () => {
  const prompt = buildOutreachUserPrompt({
    businessName: 'Acme Plumbing',
    icp: { targetIndustries: ['Manufacturing', 'Mining', 'Construction'], businessType: 'industrial services' },
  })
  // Must NOT state a false industry pulled from the seller's target market.
  assert.doesNotMatch(prompt, /Industry:\s*Manufacturing/i)
  assert.doesNotMatch(prompt, /manufacturing/i)
  // Must instead instruct inference from the business name.
  assert.match(prompt, /infer it from the business name/i)
  assert.match(prompt, /Acme Plumbing/)
})

test('buildOutreachUserPrompt: uses the provided category verbatim when present', () => {
  const prompt = buildOutreachUserPrompt({ businessName: 'Acme Plumbing', category: 'Plumbing' })
  assert.match(prompt, /Industry:\s*Plumbing/)
})

test('buildOutreachUserPrompt: includes contact first name only when provided', () => {
  assert.match(buildOutreachUserPrompt({ businessName: 'X', contactName: 'Gary Malone' }), /first name: Gary/)
  assert.doesNotMatch(buildOutreachUserPrompt({ businessName: 'X' }), /first name/)
})

test('buildOutreachUserPrompt: opens with the real personal hook when notes are provided', () => {
  const prompt = buildOutreachUserPrompt({ businessName: 'Acme Plumbing', notes: 'Met at BNI last week' })
  assert.match(prompt, /Met at BNI last week/)
  assert.match(prompt, /OPEN the email with a brief, specific, natural reference/i)
})

test('buildOutreachUserPrompt: never fabricates a relationship when no notes given', () => {
  const prompt = buildOutreachUserPrompt({ businessName: 'Acme Plumbing' })
  assert.match(prompt, /genuinely cold email; do NOT fabricate a prior relationship/i)
})
