#!/usr/bin/env node
/**
 * Live OpenAI smoke check for ACAOS's production AI adapter.
 *
 * This exercises the same service functions the API/worker use, against the real
 * configured provider, and validates the returned JSON contracts. Failure-path
 * semantics (empty envelope, malformed JSON, seller-claim rejection, quota refund)
 * remain deterministic test-suite concerns; a real provider cannot be relied on to
 * intentionally emit malformed/unsafe output on demand.
 *
 * Usage:
 *   OPENAI_API_KEY=... npm run smoke:ai-provider
 *   OPENAI_MODEL=gpt-4o-mini OPENAI_API_KEY=... npm run smoke:ai-provider
 */

import {
  analyzeReply,
  generateLeadResearch,
  generateOutreach,
  model,
  setAiProviderCallObserver,
  type AiProviderCallMeta,
} from '@acaos/backend-core/services/openai.js'
import {
  OutreachDraftOutputSchema,
  ReplyAnalysisOutputSchema,
  parseAiJson,
  parseLeadResearchJson,
} from '@acaos/backend-core/lib/aiSchemas.js'

if (!process.env.OPENAI_API_KEY) {
  console.error('FAILED: OPENAI_API_KEY is required')
  process.exit(1)
}

const calls: AiProviderCallMeta[] = []
setAiProviderCallObserver((meta) => calls.push(meta))

const results: Array<{ case: string; ok: boolean; detail?: string }> = []

async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    results.push({ case: name, ok: true })
    console.log(`✓ ${name}`)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    results.push({ case: name, ok: false, detail })
    console.error(`✗ ${name}: ${detail}`)
  }
}

console.log(`ACAOS live AI smoke — model=${model()}`)

await run('research generation + lenient schema', async () => {
  const raw = await generateLeadResearch({
    businessName: 'Fictional Test Electrical Pty Ltd',
    category: 'Electrical contractor',
    city: 'Brisbane',
    notes: 'Synthetic smoke-test prospect; do not infer real-world facts.',
  })
  const parsed = parseLeadResearchJson(raw)
  if (!parsed || typeof parsed !== 'object') throw new Error('research parser did not return an object')
})

await run('outreach generation + strict schema + seller facts', async () => {
  const raw = await generateOutreach({
    businessName: 'Fictional Test Electrical Pty Ltd',
    category: 'Electrical contractor',
    city: 'Brisbane',
    aiSummary: 'Synthetic test business used only to verify the provider integration.',
    outreachAngle: 'Ask whether upcoming project coordination is relevant.',
    icp: {
      businessType: 'contractor operations software',
      businessContext: 'The seller provides job scheduling and crew coordination software. No customer results or savings claims are supplied.',
      outreachTone: 'professional',
    },
  })
  parseAiJson(OutreachDraftOutputSchema, raw, 'smoke_outreach')
})

await run('reply analysis + strict schema', async () => {
  const raw = await analyzeReply('Thanks. Please send more information and I will review it next week.', {
    businessContext: 'The seller provides job scheduling and crew coordination software.',
  })
  parseAiJson(ReplyAnalysisOutputSchema, raw, 'smoke_reply_analysis')
})

setAiProviderCallObserver(undefined)

console.log('\nProvider calls:')
for (const [index, call] of calls.entries()) {
  console.log(JSON.stringify({
    call: index + 1,
    model: call.model,
    latencyMs: call.latencyMs,
    promptTokens: call.promptTokens,
    completionTokens: call.completionTokens,
    totalTokens: call.totalTokens,
  }))
}

console.log('\nDeterministic failure-path coverage expected in the normal test suites:')
console.log('- empty provider response → 502')
console.log('- malformed strict JSON → AI_SCHEMA_INVALID / 502')
console.log('- unsupported seller claim without seller facts → 502')
console.log('- reserved AI usage refunded on generation/schema failure')

const failed = results.filter((r) => !r.ok)
if (failed.length) process.exit(1)
console.log(`\nPASS: ${results.length}/${results.length} live AI cases succeeded.`)
