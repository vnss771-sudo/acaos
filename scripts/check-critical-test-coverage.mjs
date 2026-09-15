#!/usr/bin/env node
// Safety-critical test-coverage floor — enforced on REAL line/branch coverage,
// not on whether a test file merely mentions the module.
//
// The previous version of this gate only asserted that some test file under
// tests/, tests-db/, or tests-redis/ contained the module's import path as a
// substring. That catches a test file being deleted or the import renamed,
// but it is silent to the actual regression this gate exists to prevent: a
// guard function that still exists, is still imported, and is still called,
// but now computes the wrong answer because its branches (the ones that
// actually matter — the deny path, the cap check, the tone violation) went
// uncovered and broke without anything failing.
//
// This version spawns the fast unit tier (tests/**/*.test.ts — the same tier
// `npm test` runs, no live Postgres/Redis required) with Node's built-in
// `--experimental-test-coverage` and its `lcov` test reporter, parses the
// per-file line/branch totals, and enforces a minimum floor for each listed
// module. A test file being deleted, a guard's branch going uncovered, or the
// guard itself regressing all show up the same way here: coverage drops below
// the floor and this script fails.
//
// Floors are picked with real headroom above the coverage recorded when each
// module was added (all measured in the 90s–100% range for lines, 85%+ for
// branches) — this is a regression floor, not a target to shave against.
// Failing tests elsewhere in the suite are NOT this script's concern; `npm
// test` (run separately in `npm run verify`) already gates on that.
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')

// Resolve the unit-tier file list ourselves rather than handing `tests/**/*.test.ts`
// to `tsx --test` as a literal glob string: unlike `npm test` (defined with an
// unquoted glob in package.json, so the SHELL expands it into explicit argv
// before tsx ever sees it), this script spawns tsx directly — no shell — so an
// unexpanded glob string here depends on Node's own `--test` glob resolution,
// which has differed across Node patch versions in practice (confirmed: CI's
// `node-version: 22` consistently under-collected coverage for several files
// vs. an identical local run pinned to a specific 22.x patch). A plain
// recursive walk using only stable fs APIs removes that dependency entirely.
function findTestFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...findTestFiles(full))
    else if (entry.isFile() && entry.name.endsWith('.test.ts')) out.push(full)
  }
  return out
}
const testFiles = findTestFiles(join(ROOT, 'tests')).map((f) => relative(ROOT, f))

// Safety-critical source modules (repo-relative paths) with their minimum
// line/branch coverage in the unit tier. Adding a module here is a deliberate
// "this is load-bearing, keep it tested" signal; removing one, or lowering a
// floor, should require justification in review.
const CRITICAL = [
  // Outreach send-safety gates — a bug here sends mail it shouldn't.
  { path: 'packages/backend-core/src/lib/sendPacing.ts', lines: 80, branches: 75 },
  { path: 'packages/backend-core/src/lib/sendWindow.ts', lines: 80, branches: 75 },
  { path: 'packages/backend-core/src/lib/policyCheck.ts', lines: 80, branches: 75 },
  { path: 'packages/backend-core/src/lib/replyGating.ts', lines: 80, branches: 75 },
  { path: 'packages/backend-core/src/lib/senderReputation.ts', lines: 80, branches: 75 },
  { path: 'packages/backend-core/src/lib/suppressions.ts', lines: 80, branches: 75 },
  // Outreach tone/content policy guard — blocks presumptuous/creepy copy and
  // fabricated claims from auto-sending.
  { path: 'packages/backend-core/src/lib/outreachTone.ts', lines: 80, branches: 75 },
  // AI spend limits — the monthly-call and dollar-ceiling guards.
  { path: 'packages/backend-core/src/lib/limits.ts', lines: 80, branches: 75 },
  // Inbound reply attribution — a wrong match flips the wrong send to REPLIED.
  { path: 'packages/backend-core/src/lib/replyAttribution.ts', lines: 80, branches: 75 },
  // Tenant isolation guard — the cross-tenant query classifier.
  { path: 'packages/backend-core/src/lib/tenantGuard.ts', lines: 80, branches: 75 },
  // Auth/session/CSRF/permission primitives.
  { path: 'apps/api/src/lib/cookies.ts', lines: 80, branches: 75 },
  { path: 'apps/api/src/lib/sseTickets.ts', lines: 80, branches: 75 },
  { path: 'apps/api/src/middleware/auth.ts', lines: 80, branches: 75 },
  { path: 'packages/backend-core/src/lib/jwt.ts', lines: 80, branches: 75 },
  { path: 'packages/backend-core/src/lib/totp.ts', lines: 80, branches: 75 },
  { path: 'packages/backend-core/src/lib/accountLockout.ts', lines: 80, branches: 75 },
  { path: 'packages/backend-core/src/lib/encrypt.ts', lines: 80, branches: 75 },
  { path: 'packages/backend-core/src/lib/ssrf.ts', lines: 80, branches: 75 },
  // Scoring / signal trust.
  { path: 'packages/backend-core/src/lib/scoring.ts', lines: 80, branches: 75 },
  { path: 'packages/backend-core/src/lib/signalEngine.ts', lines: 80, branches: 75 },
]

for (const { path } of CRITICAL) {
  if (!existsSync(join(ROOT, path))) {
    console.error(`✗ listed module "${path}" does not exist — fix or remove it from CRITICAL.`)
    process.exit(1)
  }
}

// Runs the coverage-instrumented unit tier once and returns the violation
// list against CRITICAL's floors (empty when everything clears).
function runOnce() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'acaos-critical-coverage-'))
  const lcovPath = join(tmpDir, 'lcov.info')
  // A second, parallel TAP reporter purely for diagnostics: --test-reporter=lcov
  // replaces stdout's default TAP output entirely, so on a floor violation we'd
  // otherwise have no way to tell "every test genuinely ran and this module is
  // just undertested" apart from "some test file silently failed/crashed and its
  // coverage never made it into the lcov report" (Node's --test isolates each
  // test FILE into its own subprocess, and a subprocess that dies leaves its
  // coverage simply missing, not reported as an error).
  //
  // This diagnostic is what finally found the real cause of this gate's
  // CI-only floor violations: in CI (never locally), 90 of ~150 test files
  // came back `not ok`, cascading from partway through the file list onward,
  // while the sibling `npm run test:coverage` job — the exact same coverage
  // instrumentation over the exact same file set, on the exact same commit —
  // completed all 1717 tests cleanly. The one deliberate difference was
  // --test-concurrency=1, added by an earlier commit in this same
  // investigation on the theory that Node's coverage aggregation had gaps
  // under concurrency; forcing every one of ~150 test files to fork and run
  // fully serially instead apparently exhausts some CI-runner-specific
  // resource (never reproduced locally, where both settings always passed)
  // partway through the file list. Reverting to Node's default concurrency —
  // what `test:coverage` already uses successfully in this same CI — is the
  // fix.
  const tapPath = join(tmpDir, 'tap.log')
  const result = spawnSync(
    'npx',
    [
      'tsx', '--test', '--test-timeout=60000',
      '--experimental-test-coverage',
      '--test-coverage-exclude=tests/**',
      '--test-reporter=lcov',
      `--test-reporter-destination=${lcovPath}`,
      '--test-reporter=tap',
      `--test-reporter-destination=${tapPath}`,
      ...testFiles,
    ],
    {
      cwd: ROOT,
      env: { ...process.env, NODE_OPTIONS: '--conditions=acaos-src' },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    }
  )
  const tap = existsSync(tapPath) ? readFileSync(tapPath, 'utf8') : ''
  const failedTests = tap.split('\n').filter((l) => /^not ok /.test(l))
  const planMatch = tap.match(/^# tests (\d+)/m)
  const testDiagnostic = planMatch
    ? `${planMatch[1]} test(s) ran; ${failedTests.length} failed${failedTests.length ? ':\n' + failedTests.map((l) => `      ${l}`).join('\n') : ''}`
    : `no TAP plan line found (process likely crashed or timed out before finishing)`

  if (!existsSync(lcovPath)) {
    rmSync(tmpDir, { recursive: true, force: true })
    return { crashed: true, output: `${result.stdout || ''}${result.stderr || ''}\n\n[diagnostic] ${testDiagnostic}` }
  }

  // Parse LCOV, keyed by the repo-relative source path Node's lcov reporter
  // already emits (relative to the cwd the tests ran from, i.e. ROOT).
  const perFile = new Map()
  let current = null
  for (const line of readFileSync(lcovPath, 'utf8').split('\n')) {
    if (line.startsWith('SF:')) { current = line.slice(3).trim(); perFile.set(current, {}) }
    else if (current && line.startsWith('LF:')) perFile.get(current).linesFound = Number(line.slice(3))
    else if (current && line.startsWith('LH:')) perFile.get(current).linesHit = Number(line.slice(3))
    else if (current && line.startsWith('BRF:')) perFile.get(current).branchesFound = Number(line.slice(4))
    else if (current && line.startsWith('BRH:')) perFile.get(current).branchesHit = Number(line.slice(4))
  }
  rmSync(tmpDir, { recursive: true, force: true })

  const errors = []
  for (const { path, lines: lineFloor, branches: branchFloor } of CRITICAL) {
    const cov = perFile.get(path)
    if (!cov || !cov.linesFound) {
      errors.push(`${path}: not exercised by any test in the unit tier (0% coverage) — must clear ${lineFloor}% lines / ${branchFloor}% branches.`)
      continue
    }
    const linePct = (100 * (cov.linesHit ?? 0)) / cov.linesFound
    // A file with zero branches (e.g. a handful of straight-line statements)
    // is vacuously 100% branch-covered rather than divide-by-zero failing it.
    const branchPct = cov.branchesFound ? (100 * (cov.branchesHit ?? 0)) / cov.branchesFound : 100
    if (linePct < lineFloor) errors.push(`${path}: line coverage ${linePct.toFixed(1)}% is below the ${lineFloor}% floor.`)
    if (branchPct < branchFloor) errors.push(`${path}: branch coverage ${branchPct.toFixed(1)}% is below the ${branchFloor}% floor.`)
  }
  return { crashed: false, errors, testDiagnostic }
}

// This gate showed a real, consistent CI-only failure mode across several
// earlier fix attempts (see PR discussion): floor violations against modules
// that passed 100% clean under `npm test` and under this exact script run
// locally, reproduced with a from-scratch `npm ci` and the exact CI-observed
// Node patch version, ruling out file-selection, install staleness, and the
// Node patch as the cause. The actual cause (found via the TAP diagnostic
// above): a since-reverted `--test-concurrency=1` was silently failing ~90 of
// ~150 test files in CI's runner specifically, starving the coverage report
// of real data for whatever module happened to depend on a later-failing
// file — not a coverage-instrumentation gap at all.
// `--experimental-test-coverage` is still, per its name, not a stable API, so
// the retry-3x below is kept as a safety net against any remaining
// instability; nothing is ever skipped, disabled, or weakened on a retry —
// every attempt re-runs the identical unit tier, and a genuine regression
// still fails identically every time.
const MAX_ATTEMPTS = 3
let lastErrors = []
let lastCrashOutput = null
let passed = false
for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  console.log(`[check:critical-test-coverage] Running the unit test tier with coverage instrumentation (attempt ${attempt}/${MAX_ATTEMPTS}, mirrors \`npm test\` timing)…`)
  const { crashed, output, errors, testDiagnostic } = runOnce()
  if (crashed) {
    lastCrashOutput = output
    console.error(`  attempt ${attempt} crashed before producing a coverage report; ${attempt < MAX_ATTEMPTS ? 'retrying' : 'out of attempts'}.`)
    continue
  }
  lastCrashOutput = null
  if (errors.length === 0) { passed = true; break }
  lastErrors = errors
  console.error(`  attempt ${attempt}/${MAX_ATTEMPTS} found ${errors.length} floor violation(s)${attempt < MAX_ATTEMPTS ? ' — retrying once to rule out coverage-instrumentation flakiness' : ''}:`)
  for (const e of errors) console.error(`    ${e}`)
  console.error(`  [diagnostic] underlying test run: ${testDiagnostic}`)
}

if (lastCrashOutput !== null) {
  console.error('✗ No coverage report was produced in any attempt — the test run crashed before finishing:')
  console.error(lastCrashOutput)
  process.exit(1)
}
if (!passed) {
  console.error(`✗ Safety-critical test-coverage floor violated on all ${MAX_ATTEMPTS} attempts (not a one-off — see scripts/check-critical-test-coverage.mjs):`)
  for (const e of lastErrors) console.error(`    ${e}`)
  process.exit(1)
}
console.log(`✓ All ${CRITICAL.length} safety-critical modules meet their line/branch coverage floor.`)
