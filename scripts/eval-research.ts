/**
 * Lead-research quality eval — a runnable gate for the evidence-backed research
 * output (the contract added in PR #218).
 *
 * Generates real research for representative leads and asserts the trust bar:
 * well-formed evidence[] (every item has a signal + a valid provenance type +
 * confidence), the HONESTY rule (a "confirmed" item must cite a real sourceUrl —
 * a confident-sounding guess must be "inferred"), risk flags on inference-heavy
 * assessments, a valid recommendedAction, an in-range icpScore, and no vague
 * filler in the summary.
 *
 * Usage:  OPENAI_API_KEY=sk-... npm run eval:research
 * Without a key it skips (exit 0) so it never blocks CI; run it locally or in a
 * keyed job to confirm the live model actually emits the richer shape.
 *
 * The evaluator (evaluateResearch) is exported and pure so its logic is unit
 * tested in tests/eval-research.test.ts without needing a key or the network.
 */
import { generateLeadResearch } from '../apps/api/src/services/openai.js'

type ResearchInput = Parameters<typeof generateLeadResearch>[0]

export type ResearchCase = {
  name: string
  input: ResearchInput
  // Tokens proving the assessment understood the lead's real trade.
  expectIndustryAnyOf: string[]
}

// A field-service ICP; the leads below are deliberately varied trades.
const FIELD_ICP = {
  targetIndustries: ['Plumbing', 'Electrical', 'HVAC', 'Construction'],
  businessType: 'field operations software',
  outreachTone: 'direct',
}

export const RESEARCH_CASES: ResearchCase[] = [
  {
    name: 'Plumbing SMB with a website',
    input: {
      businessName: 'Acme Plumbing Brisbane',
      website: 'https://acmeplumbingbrisbane.com.au',
      category: 'plumbing',
      city: 'Brisbane',
      notes: 'Met at BNI last week; mentioned they are hiring',
      icp: FIELD_ICP,
    },
    expectIndustryAnyOf: ['plumb'],
  },
  {
    name: 'Electrical, minimal info',
    input: { businessName: 'Smith Electrical', category: 'electrical', icp: FIELD_ICP },
    expectIndustryAnyOf: ['electric'],
  },
  {
    name: 'HVAC with website',
    input: {
      businessName: 'Coastal HVAC Services',
      website: 'https://coastalhvac.example',
      city: 'Gold Coast',
      icp: FIELD_ICP,
    },
    expectIndustryAnyOf: ['hvac', 'air', 'heating', 'cooling'],
  },
]

const EVIDENCE_TYPES = new Set(['confirmed', 'observed', 'inferred'])
const CONFIDENCE_LEVELS = new Set(['low', 'medium', 'high'])
const RECOMMENDED_ACTIONS = new Set(['auto_draft', 'manual_review_then_draft', 'skip'])

// Vague corporate filler that should never appear in the research summary/angle.
const BANNED_FILLER = ['streamline operations', 'improve efficiency', 'leverage', 'synergy', 'drive growth', 'optimi', 'cutting-edge', 'best-in-class', 'industrial services']

export type Finding = { case: string; severity: 'FAIL' | 'WARN'; message: string }

type EvidenceItem = { signal?: unknown; type?: unknown; confidence?: unknown; sourceUrl?: unknown }

/** Evaluate one raw research response against the evidence-backed contract. Pure. */
export function evaluateResearch(c: ResearchCase, raw: string): Finding[] {
  const F: Finding[] = []
  const fail = (message: string) => F.push({ case: c.name, severity: 'FAIL', message })
  const warn = (message: string) => F.push({ case: c.name, severity: 'WARN', message })

  let parsed: Record<string, unknown>
  try {
    const j: unknown = JSON.parse(raw)
    if (!j || typeof j !== 'object' || Array.isArray(j)) { fail('output was not a JSON object'); return F }
    parsed = j as Record<string, unknown>
  } catch {
    fail('output was not valid JSON')
    return F
  }

  // ── evidence[] shape + honesty ────────────────────────────────────────────
  const evidence = parsed.evidence
  if (!Array.isArray(evidence) || evidence.length === 0) {
    fail('no evidence[] — the evidence-backed contract requires at least one item')
  } else {
    let inferredCount = 0
    evidence.forEach((raw, i) => {
      const e = (raw ?? {}) as EvidenceItem
      const where = `evidence[${i}]`
      if (typeof e.signal !== 'string' || !e.signal.trim()) fail(`${where} missing a signal`)
      if (typeof e.type !== 'string' || !EVIDENCE_TYPES.has(e.type)) {
        fail(`${where} invalid type ${JSON.stringify(e.type)}`)
      }
      if (typeof e.confidence !== 'string' || !CONFIDENCE_LEVELS.has(e.confidence)) {
        fail(`${where} invalid confidence ${JSON.stringify(e.confidence)}`)
      }
      // THE honesty rule: "confirmed" must cite a real source.
      if (e.type === 'confirmed' && (typeof e.sourceUrl !== 'string' || !/^https?:\/\//i.test(e.sourceUrl))) {
        fail(`${where} is "confirmed" without a real sourceUrl — a guess must be "inferred"`)
      }
      if (e.type === 'inferred') inferredCount++
    })
    // Inference-heavy assessments must carry caveats AND not auto-send.
    const riskFlags = parsed.riskFlags
    if (inferredCount > 0 && (!Array.isArray(riskFlags) || riskFlags.length === 0)) {
      warn('evidence includes inferences but no riskFlags were provided')
    }
    if (inferredCount >= evidence.length && parsed.recommendedAction === 'auto_draft') {
      fail('recommendedAction=auto_draft on an all-inferred assessment')
    }
  }

  // ── enums ─────────────────────────────────────────────────────────────────
  if (parsed.recommendedAction === undefined) warn('no recommendedAction')
  else if (typeof parsed.recommendedAction !== 'string' || !RECOMMENDED_ACTIONS.has(parsed.recommendedAction)) {
    fail(`invalid recommendedAction ${JSON.stringify(parsed.recommendedAction)}`)
  }
  if (parsed.confidence !== undefined && (typeof parsed.confidence !== 'string' || !CONFIDENCE_LEVELS.has(parsed.confidence))) {
    fail(`invalid confidence ${JSON.stringify(parsed.confidence)}`)
  }

  // ── icpScore ──────────────────────────────────────────────────────────────
  const icp = parsed.icpScore
  if (typeof icp !== 'number') warn('no numeric icpScore')
  else if (icp < 0 || icp > 100) fail(`icpScore out of range: ${icp}`)

  // ── summary quality ───────────────────────────────────────────────────────
  const summaryBlob = `${String(parsed.aiSummary ?? '')}\n${String(parsed.outreachAngle ?? '')}`.toLowerCase()
  for (const phrase of BANNED_FILLER) {
    if (summaryBlob.includes(phrase)) fail(`used banned filler: "${phrase}"`)
  }
  if (!c.expectIndustryAnyOf.some((t) => summaryBlob.includes(t))) {
    warn(`did not reference the lead's trade (expected one of: ${c.expectIndustryAnyOf.join(', ')})`)
  }
  if (typeof parsed.outreachAngle !== 'string' || !parsed.outreachAngle.trim()) {
    warn('empty outreachAngle')
  }

  return F
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.log('⏭  OPENAI_API_KEY not set — skipping research eval (set it to run).')
    process.exit(0)
  }

  console.log(`Running lead-research eval (${RESEARCH_CASES.length} cases, model=${process.env.OPENAI_MODEL || 'gpt-4o-mini'})\n`)
  const all: Finding[] = []

  for (const c of RESEARCH_CASES) {
    process.stdout.write(`• ${c.name} … `)
    try {
      const raw = await generateLeadResearch(c.input)
      const findings = evaluateResearch(c, raw)
      all.push(...findings)
      const fails = findings.filter((f) => f.severity === 'FAIL').length
      const warns = findings.filter((f) => f.severity === 'WARN').length
      console.log(fails ? `❌ ${fails} fail, ${warns} warn` : warns ? `⚠️  ${warns} warn` : '✅ pass')
      try {
        const p = JSON.parse(raw)
        const ev = Array.isArray(p.evidence) ? p.evidence.length : 0
        console.log(`    score: ${p.icpScore}  action: ${p.recommendedAction}  evidence: ${ev}  risks: ${Array.isArray(p.riskFlags) ? p.riskFlags.length : 0}\n`)
      } catch { /* reported above */ }
    } catch (err) {
      all.push({ case: c.name, severity: 'FAIL', message: `generation threw: ${err instanceof Error ? err.message : String(err)}` })
      console.log('❌ threw')
    }
  }

  const fails = all.filter((f) => f.severity === 'FAIL')
  const warns = all.filter((f) => f.severity === 'WARN')
  if (all.length) {
    console.log('— Findings —')
    for (const f of all) console.log(`  ${f.severity === 'FAIL' ? '❌' : '⚠️ '} [${f.case}] ${f.message}`)
  }
  console.log(`\nResult: ${fails.length} FAIL, ${warns.length} WARN across ${RESEARCH_CASES.length} cases.`)
  process.exit(fails.length > 0 ? 1 : 0)
}

// Only run when invoked directly (not when imported by the unit test).
if (process.argv[1] && process.argv[1].endsWith('eval-research.ts')) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
