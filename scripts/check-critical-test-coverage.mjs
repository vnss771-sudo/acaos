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
// Sorted for a deterministic run order matching `tests/**/*.test.ts` as the
// SHELL expands it for `npm test`/`npm run test:coverage` (always
// alphabetical) — `readdirSync`'s own order is filesystem-dependent, not
// alphabetical, and can differ between environments for the identical file
// set. See the TAP diagnostic below: this script's own file order (raw
// readdirSync, unsorted) reproducibly fails ~90 of ~150 test files in CI
// while the alphabetically-sorted glob `test:coverage` uses passes clean on
// the exact same commit, which points at order-dependent state leaking
// between test files rather than a coverage-instrumentation gap.
const testFiles = findTestFiles(join(ROOT, 'tests')).map((f) => relative(ROOT, f)).sort()

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
  // came back `not ok`, while the sibling `npm run test:coverage` job — the
  // exact same coverage instrumentation over the exact same file set, on the
  // exact same commit — completed all 1717 tests cleanly. Neither
  // --test-concurrency=1 (an earlier commit's now-reverted attempt) nor
  // unsorted file order (readdirSync vs. a sorted glob — tested by sorting
  // testFiles above) explain it: removing concurrency=1 reproduced the exact
  // same 90 failures, and the CI failure indices already lined up with sorted
  // order before the sort was added.
  //
  // One explanation tried: `spawnSync` defaults `maxBuffer` to 1MB, and ~150
  // forked test-file subprocesses under `--experimental-test-coverage` could
  // plausibly cross that combined with stdout/stderr volume in CI. Raising
  // maxBuffer to 200MB (below) removes that ceiling — but did NOT fix it.
  //
  // Next tried: `--test-concurrency=2` (below), on the theory that halving
  // concurrent worker memory pressure vs. the default (os.availableParallelism(),
  // 4 on CI's runner) would stop workers from being silently killed. This
  // ALSO did not fix it — CI reproduced the identical ~90-file failure count
  // on this exact combination (maxBuffer=200MB + concurrency=2). Combined
  // with the earlier, separate finding that concurrency=1 alone (before
  // maxBuffer existed) reproduced the same failures as default concurrency,
  // concurrency is now ruled out as the causal variable across its full
  // range (1, 2, and default) — this was a red herring, not a fix.
  //
  // The actual gap: every previous debugging pass stopped at the bare
  // `not ok <file>` TAP line and discarded the indented YAML diagnostic block
  // Node emits right after it (error/stack/signal) — the one thing that would
  // distinguish "a real assertion failed" from "this subprocess was killed."
  // The diagnostic extraction below finally captures it. Concurrency stays at
  // 2 (still a reasonable conservative default, just not the fix), and the
  // next CI-only failure should come back with an actual reason instead of a
  // bare file list.
  const tapPath = join(tmpDir, 'tap.log')
  const result = spawnSync(
    'npx',
    [
      'tsx', '--test', '--test-timeout=60000',
      // Caps how many test FILES run as concurrent worker processes at once.
      // Node's --test default is os.availableParallelism() (4 on both this
      // sandbox and CI's runner), and coverage instrumentation multiplies each
      // worker's memory footprint — raising maxBuffer (above) fixed output
      // truncation but not this: CI's runner has less real headroom under that
      // 4-way concurrent load than this sandbox does, and Node's test runner
      // reports a crashed/OOM-killed worker as its file coming back `not ok`,
      // not as a distinguishable crash. Untested combination: concurrency=1 was
      // ruled out in isolation, before maxBuffer existed; 2 halves peak
      // concurrent memory vs the default 4 while still running in parallel.
      '--test-concurrency=2',
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
      maxBuffer: 1024 * 1024 * 200,
    }
  )
  const tap = existsSync(tapPath) ? readFileSync(tapPath, 'utf8') : ''
  const tapLines = tap.split('\n')
  const failedTests = tapLines.filter((l) => /^not ok /.test(l))
  // Every prior debugging pass here stopped at the bare `not ok` line and never
  // looked at what follows it: Node's TAP reporter emits an indented YAML
  // diagnostic block (---/…/--- delimited) after each failing test with the
  // actual error/stack/signal — exactly the detail needed to tell "a real
  // assertion failed" from "this subprocess was killed" apart. Pull that block
  // for the first few failures so a floor violation finally carries a reason
  // instead of just a file list.
  const SAMPLE_DIAGNOSTICS = 3
  const diagnosticBlocks = []
  for (let i = 0; i < tapLines.length && diagnosticBlocks.length < SAMPLE_DIAGNOSTICS; i++) {
    if (!/^not ok /.test(tapLines[i])) continue
    const block = [tapLines[i]]
    let j = i + 1
    while (j < tapLines.length && (tapLines[j] === '' || /^\s/.test(tapLines[j])) && !/^(ok |not ok )/.test(tapLines[j])) {
      block.push(tapLines[j])
      j++
    }
    diagnosticBlocks.push(block.join('\n'))
  }
  const planMatch = tap.match(/^# tests (\d+)/m)
  const testDiagnostic = planMatch
    ? `${planMatch[1]} test(s) ran; ${failedTests.length} failed${failedTests.length ? ':\n' + failedTests.map((l) => `      ${l}`).join('\n') : ''}` +
      (diagnosticBlocks.length ? `\n\n  [diagnostic] first ${diagnosticBlocks.length} failure(s) in detail:\n${diagnosticBlocks.map((b) => b.split('\n').map((l) => `      ${l}`).join('\n')).join('\n\n')}` : '')
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
// Node patch as the cause. The TAP diagnostic above found the actual shape of
// the problem: ~90 of ~150 test files silently coming back `not ok` in CI's
// runner specifically, starving the coverage report of real data for
// whatever module happened to depend on a later-failing file — not a
// coverage-instrumentation gap at all. Two further hypotheses for WHY
// (--test-concurrency=1, unsorted file order) were tested and ruled out
// in-place above; `maxBuffer` is the current leading explanation and fix.
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
