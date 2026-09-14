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
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')

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

const tmpDir = mkdtempSync(join(tmpdir(), 'acaos-critical-coverage-'))
const lcovPath = join(tmpDir, 'lcov.info')

console.log('[check:critical-test-coverage] Running the unit test tier with coverage instrumentation (mirrors `npm test` timing)…')
const result = spawnSync(
  'npx',
  [
    'tsx', '--test', '--test-timeout=60000',
    '--experimental-test-coverage',
    '--test-coverage-exclude=tests/**',
    '--test-reporter=lcov',
    `--test-reporter-destination=${lcovPath}`,
    'tests/**/*.test.ts',
  ],
  {
    cwd: ROOT,
    env: { ...process.env, NODE_OPTIONS: '--conditions=acaos-src' },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  }
)

if (!existsSync(lcovPath)) {
  console.error('✗ No coverage report was produced — the test run crashed before finishing:')
  console.error(result.stdout || '')
  console.error(result.stderr || '')
  rmSync(tmpDir, { recursive: true, force: true })
  process.exit(1)
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
  // A file with zero branches (e.g. a handful of straight-line statements) is
  // vacuously 100% branch-covered rather than divide-by-zero failing it.
  const branchPct = cov.branchesFound ? (100 * (cov.branchesHit ?? 0)) / cov.branchesFound : 100
  if (linePct < lineFloor) errors.push(`${path}: line coverage ${linePct.toFixed(1)}% is below the ${lineFloor}% floor.`)
  if (branchPct < branchFloor) errors.push(`${path}: branch coverage ${branchPct.toFixed(1)}% is below the ${branchFloor}% floor.`)
}

if (errors.length) {
  console.error('✗ Safety-critical test-coverage floor violated:')
  for (const e of errors) console.error(`    ${e}`)
  console.error('  See scripts/check-critical-test-coverage.mjs.')
  process.exit(1)
}
console.log(`✓ All ${CRITICAL.length} safety-critical modules meet their line/branch coverage floor.`)
