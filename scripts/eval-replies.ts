/**
 * Reply-classification eval — a labelled test set for analyzeReply.
 *
 * Runs every reply in scripts/eval-data/replies.json through the live
 * classifier and scores it against the human label. Unlike the outreach and
 * research evals (which check the *shape* of generated text), this one checks
 * *correctness*: classification drives CRM stage, lead scoring and follow-up
 * automation, so a prompt tweak or model swap that quietly drops accuracy is
 * a real product regression.
 *
 * Gate (exit 1) when either:
 *   - accuracy falls below EVAL_REPLY_ACCURACY_FLOOR (default 0.9), or
 *   - any case marked `critical` fails (unsubscribe/abuse, auto-replies and
 *     bounces, prompt-injection attempts) — these must never regress,
 *     whatever the overall accuracy.
 * WARNs (urgency mismatch, a keyQuote not found in the reply) never gate.
 *
 * Usage:  OPENAI_API_KEY=sk-... npm run eval:replies
 * Without a key it skips (exit 0) so it never blocks CI.
 *
 * The dataset loader and evaluator are exported and pure so they're unit
 * tested in tests/eval-replies.test.ts without a key or the network.
 */
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { analyzeReply } from '../apps/api/src/services/openai.js'
import {
  REPLY_CLASSIFICATIONS,
  REPLY_URGENCIES,
  ReplyAnalysisOutputSchema,
} from '@acaos/backend-core/lib/aiSchemas.js'
import { appendEvalRun, computeLift, formatLift, type EvalFinding } from './lib/evalHistory.js'
import { appendStepSummary, readHistoryFile, writeHistoryFile } from './lib/evalHistoryStore.js'

const DATASET_PATH = new URL('./eval-data/replies.json', import.meta.url).pathname
const HISTORY_PATH = new URL('../eval-results/replies.json', import.meta.url).pathname

// Live calls run a few at a time: fast enough for ~50 cases, gentle on rate limits.
const CONCURRENCY = 4
const DEFAULT_ACCURACY_FLOOR = 0.9

export type ReplyClass = (typeof REPLY_CLASSIFICATIONS)[number]
type Urgency = (typeof REPLY_URGENCIES)[number]

export type ReplyCase = {
  id: string
  reply: string
  expected: ReplyClass
  acceptable?: ReplyClass[]
  expectAutoReply?: boolean
  urgencyAnyOf?: Urgency[]
  forbiddenOutput?: string[]
  critical?: boolean
  tags?: string[]
  note?: string
}

export type Finding = EvalFinding

export type CaseResult = {
  id: string
  expected: ReplyClass
  actual: string | null
  correct: boolean
  critical: boolean
  findings: Finding[]
}

const CLASS_SET = new Set<string>(REPLY_CLASSIFICATIONS)
const URGENCY_SET = new Set<string>(REPLY_URGENCIES)

/**
 * Validate the raw dataset JSON and return typed cases. Throws with every
 * problem listed, so a bad label is caught by the unit test rather than
 * surfacing as a confusing live-eval miss. Pure.
 */
export function parseDataset(json: unknown): ReplyCase[] {
  const cases = (json as { cases?: unknown })?.cases
  if (!Array.isArray(cases) || cases.length === 0) throw new Error('dataset has no cases[]')
  const errors: string[] = []
  const seen = new Set<string>()
  cases.forEach((raw, i) => {
    const c = (raw ?? {}) as Record<string, unknown>
    const where = typeof c.id === 'string' ? c.id : `cases[${i}]`
    if (typeof c.id !== 'string' || !/^[a-z0-9-]+$/.test(c.id)) errors.push(`${where}: id must be kebab-case`)
    else if (seen.has(c.id)) errors.push(`${where}: duplicate id`)
    else seen.add(c.id)
    if (typeof c.reply !== 'string' || !c.reply.trim()) errors.push(`${where}: reply is empty`)
    if (typeof c.expected !== 'string' || !CLASS_SET.has(c.expected)) {
      errors.push(`${where}: expected ${JSON.stringify(c.expected)} is not a valid classification`)
    }
    if (c.acceptable !== undefined) {
      if (!Array.isArray(c.acceptable) || c.acceptable.some((a) => typeof a !== 'string' || !CLASS_SET.has(a))) {
        errors.push(`${where}: acceptable must be a list of valid classifications`)
      } else if (c.acceptable.includes(c.expected)) {
        errors.push(`${where}: acceptable repeats the expected label`)
      }
    }
    if (c.urgencyAnyOf !== undefined) {
      if (!Array.isArray(c.urgencyAnyOf) || c.urgencyAnyOf.some((u) => typeof u !== 'string' || !URGENCY_SET.has(u))) {
        errors.push(`${where}: urgencyAnyOf must be a list of valid urgencies`)
      }
    }
    if (c.expectAutoReply !== undefined && typeof c.expectAutoReply !== 'boolean') {
      errors.push(`${where}: expectAutoReply must be a boolean`)
    }
    if (c.forbiddenOutput !== undefined) {
      if (!Array.isArray(c.forbiddenOutput) || c.forbiddenOutput.some((s) => typeof s !== 'string' || !s)) {
        errors.push(`${where}: forbiddenOutput must be a list of non-empty strings`)
      }
    }
  })
  if (errors.length) throw new Error(`invalid reply eval dataset:\n  ${errors.join('\n  ')}`)
  return cases as ReplyCase[]
}

export function loadDataset(path = DATASET_PATH): ReplyCase[] {
  return parseDataset(JSON.parse(readFileSync(path, 'utf8')))
}

// Whitespace/case/quote-style-insensitive, so a keyQuote that trims a line
// break or swaps a curly apostrophe still counts as a real quote.
function normalise(s: string): string {
  return s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim()
}

/** Score one raw analyzeReply response against its label. Pure. */
export function evaluateReply(c: ReplyCase, raw: string): CaseResult {
  const findings: Finding[] = []
  const fail = (message: string) => findings.push({ case: c.id, severity: 'FAIL', message })
  const warn = (message: string) => findings.push({ case: c.id, severity: 'WARN', message })
  const result = (actual: string | null, correct: boolean): CaseResult =>
    ({ id: c.id, expected: c.expected, actual, correct, critical: !!c.critical, findings })

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    fail('output was not valid JSON')
    return result(null, false)
  }
  // Same strict schema the worker parses with — output it rejects would fail
  // the job in production, so it can't count as a correct classification here.
  const parsed = ReplyAnalysisOutputSchema.safeParse(json)
  if (!parsed.success) {
    const cls = (json as { classification?: unknown })?.classification
    fail(`output failed the production schema (classification=${JSON.stringify(cls)})`)
    return result(typeof cls === 'string' ? cls : null, false)
  }
  const out = parsed.data

  const correct = out.classification === c.expected || (c.acceptable ?? []).includes(out.classification)
  if (!correct) fail(`classified ${out.classification}, expected ${c.expected}`)

  if (c.expectAutoReply !== undefined && out.isAutoReply !== c.expectAutoReply) {
    fail(`isAutoReply=${String(out.isAutoReply)}, expected ${String(c.expectAutoReply)}`)
  }
  for (const s of c.forbiddenOutput ?? []) {
    if (raw.includes(s)) fail(`output contains injected text ${JSON.stringify(s)}`)
  }

  if (c.urgencyAnyOf && (!out.urgency || !c.urgencyAnyOf.includes(out.urgency))) {
    warn(`urgency ${JSON.stringify(out.urgency)}, expected one of ${c.urgencyAnyOf.join(', ')}`)
  }
  if (out.keyQuote && !normalise(c.reply).includes(normalise(out.keyQuote))) {
    warn(`keyQuote is not in the reply: ${JSON.stringify(out.keyQuote)}`)
  }

  return result(out.classification, correct)
}

export type Summary = {
  cases: number
  correct: number
  accuracy: number
  criticalFailures: string[]
  perClass: Record<ReplyClass, { total: number; correct: number }>
  confusions: Array<{ id: string; expected: ReplyClass; actual: string | null }>
}

/** Roll per-case results up into accuracy, per-class recall and the misses. Pure. */
export function summarise(results: CaseResult[]): Summary {
  const perClass = Object.fromEntries(
    REPLY_CLASSIFICATIONS.map((k) => [k, { total: 0, correct: 0 }]),
  ) as Summary['perClass']
  for (const r of results) {
    perClass[r.expected].total++
    if (r.correct) perClass[r.expected].correct++
  }
  const correct = results.filter((r) => r.correct).length
  return {
    cases: results.length,
    correct,
    accuracy: results.length ? correct / results.length : 0,
    criticalFailures: results
      .filter((r) => r.critical && r.findings.some((f) => f.severity === 'FAIL'))
      .map((r) => r.id),
    perClass,
    confusions: results.filter((r) => !r.correct).map(({ id, expected, actual }) => ({ id, expected, actual })),
  }
}

/** Accuracy floor from env, clamped to (0, 1]; a bad value falls back to the default. */
export function accuracyFloor(envValue: string | undefined): number {
  const n = Number(envValue)
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : DEFAULT_ACCURACY_FLOOR
}

async function runPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

const pct = (n: number) => `${Math.round(n * 1000) / 10}%`

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.log('⏭  OPENAI_API_KEY not set — skipping reply eval (set it to run).')
    process.exit(0)
  }

  const cases = loadDataset()
  const floor = accuracyFloor(process.env.EVAL_REPLY_ACCURACY_FLOOR)
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini'
  console.log(`Running reply-classification eval (${cases.length} cases, model=${model}, floor=${pct(floor)})\n`)

  const results = await runPool(cases, CONCURRENCY, async (c): Promise<CaseResult> => {
    try {
      return evaluateReply(c, await analyzeReply(c.reply))
    } catch (err) {
      const message = `analyzeReply threw: ${err instanceof Error ? err.message : String(err)}`
      return { id: c.id, expected: c.expected, actual: null, correct: false, critical: !!c.critical, findings: [{ case: c.id, severity: 'FAIL', message }] }
    }
  })

  for (const r of results) {
    const fails = r.findings.filter((f) => f.severity === 'FAIL').length
    const warns = r.findings.length - fails
    const mark = fails ? '❌' : warns ? '⚠️ ' : '✅'
    console.log(`${mark} ${r.id.padEnd(34)} ${String(r.actual ?? '—').padEnd(16)}${r.critical ? ' [critical]' : ''}`)
    for (const f of r.findings) console.log(`     ${f.severity}: ${f.message}`)
  }

  const s = summarise(results)
  console.log('\n— Per-class recall —')
  for (const [k, v] of Object.entries(s.perClass)) {
    console.log(`  ${k.padEnd(16)} ${v.correct}/${v.total}${v.total ? `  (${pct(v.correct / v.total)})` : ''}`)
  }
  const all = results.flatMap((r) => r.findings)
  const fails = all.filter((f) => f.severity === 'FAIL').length
  const warns = all.length - fails
  console.log(`\nAccuracy: ${s.correct}/${s.cases} (${pct(s.accuracy)}), floor ${pct(floor)}`)
  if (s.criticalFailures.length) console.log(`Critical cases failed: ${s.criticalFailures.join(', ')}`)

  // Score = accuracy %, so the trend in eval-results/replies.json reads as
  // accuracy over time. (The shared FAIL/WARN penalty score floors at 0 after
  // five misses, which is meaningless for a ~50-case classification set.)
  const score = Math.round(s.accuracy * 100)
  const history = readHistoryFile(HISTORY_PATH)
  const lift = computeLift(history, score)
  console.log(formatLift(lift, score))
  appendStepSummary(
    `### Reply classification eval\n\n${formatLift(lift, score)}\n\n` +
    `Accuracy ${s.correct}/${s.cases} (floor ${pct(floor)})` +
    (s.criticalFailures.length ? ` — **critical failures:** ${s.criticalFailures.join(', ')}` : '') + '\n',
  )
  let gitSha: string | undefined
  try { gitSha = execSync('git rev-parse HEAD').toString().trim() } catch { /* not fatal */ }
  writeHistoryFile(HISTORY_PATH, appendEvalRun(history, {
    recordedAt: new Date().toISOString(),
    gitSha,
    model,
    score,
    fails,
    warns,
    cases: s.cases,
  }))

  process.exit(s.accuracy < floor || s.criticalFailures.length > 0 ? 1 : 0)
}

// Only run when invoked directly (not when imported by the unit test).
if (process.argv[1] && process.argv[1].endsWith('eval-replies.ts')) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
