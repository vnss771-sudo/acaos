#!/usr/bin/env node
// Safety-critical test-coverage floor.
//
// The suite's aggregate coverage gate (test:coverage lines/branches/functions)
// is a whole-repo average — it stays green even if the *only* test for an
// individual safety-critical module is deleted, because dozens of well-covered
// files mask the regression. This guard closes that gap for a curated set of
// modules where a silent loss of coverage is high-impact (send-eligibility,
// reply attribution, auth cookies/CSRF, SSE tickets, suppressions, etc.): each
// listed source file MUST be referenced by at least one test in tests/,
// tests-db/, or tests-redis/. It does NOT measure line coverage — it pins the
// existence of a test, so the floor can't quietly drop to zero.
//
// Adding a module here is a deliberate "this is load-bearing, keep it tested"
// signal. Removing one should require justification in review.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')

// Safety-critical source modules (repo-relative paths) that must stay tested.
const CRITICAL = [
  // Outreach send-safety gates — a bug here sends mail it shouldn't.
  'packages/backend-core/src/lib/sendPacing.ts',
  'packages/backend-core/src/lib/sendWindow.ts',
  'packages/backend-core/src/lib/policyCheck.ts',
  'packages/backend-core/src/lib/replyGating.ts',
  'packages/backend-core/src/lib/senderReputation.ts',
  'packages/backend-core/src/lib/suppressions.ts',
  // Inbound reply attribution — a wrong match flips the wrong send to REPLIED.
  'packages/backend-core/src/lib/replyAttribution.ts',
  // Auth/session/CSRF primitives.
  'apps/api/src/lib/cookies.ts',
  'apps/api/src/lib/sseTickets.ts',
  'apps/api/src/lib/readiness.ts',
  'packages/backend-core/src/lib/jwt.ts',
  'packages/backend-core/src/lib/totp.ts',
  'packages/backend-core/src/lib/encrypt.ts',
  'packages/backend-core/src/lib/ssrf.ts',
  // Scoring / signal trust.
  'packages/backend-core/src/lib/scoring.ts',
  'packages/backend-core/src/lib/signalEngine.ts',
]

// Known-untested, load-bearing modules we have NOT yet covered. Listed here so
// the gap is recorded in-repo rather than forgotten; promote them into CRITICAL
// (above) once they have tests. Do NOT add covered modules here.
//   - packages/backend-core/src/lib/sendDecision.ts  (canSendOutreach: the central
//     send-eligibility gate; currently has no test AND no callers — confirm it is
//     wired before relying on it, then test every reason branch.)

const TEST_DIRS = ['tests', 'tests-db', 'tests-redis']

function walk(dir) {
  const out = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

// Gather the text of every test file once.
const testSources = TEST_DIRS.flatMap((d) => walk(join(ROOT, d))).map((f) => readFileSync(f, 'utf8'))

const errors = []
for (const modulePath of CRITICAL) {
  if (!existsSync(join(ROOT, modulePath))) {
    errors.push(`listed module "${modulePath}" does not exist — fix or remove it from CRITICAL.`)
    continue
  }
  // Tests import source modules by their path (e.g. ../apps/api/src/lib/cookies.ts);
  // the specifier may carry a .ts or a .js extension, so match either.
  const base = modulePath.replace(/\.ts$/, '')
  const referenced = testSources.some((src) => src.includes(base + '.ts') || src.includes(base + '.js'))
  if (!referenced) {
    errors.push(`no test in {${TEST_DIRS.join(', ')}}/ references "${modulePath}" — this safety-critical module must stay tested.`)
  }
}

if (errors.length) {
  console.error('✗ Safety-critical test-coverage floor violated:')
  for (const e of errors) console.error(`    ${e}`)
  console.error('  See scripts/check-critical-test-coverage.mjs.')
  process.exit(1)
}
console.log(`✓ All ${CRITICAL.length} safety-critical modules are referenced by a test.`)
