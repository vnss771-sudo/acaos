#!/usr/bin/env node
// Ratcheting guard against raw, untyped frontend API mutations (A+ review finding
// P1-5). Production frontend code must route mutations through the typed client
// (apps/web/src/lib/routeApi.ts), not hand-build `body: JSON.stringify(...)`, so
// the request shape can never drift from the shared RouteContracts.
//
// This is a RATCHET: ALLOWLIST holds the files that still contain raw mutations
// today. CI fails if:
//   1. a file NOT on the allowlist introduces a raw mutation (no backsliding), or
//   2. a file ON the allowlist no longer has any (it migrated — remove it so the
//      list keeps shrinking and can never silently grow stale).
// The end state is an empty allowlist, at which point the pattern is fully banned.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const SRC = join(ROOT, 'apps/web/src')
const PATTERN = /body:\s*JSON\.stringify\(/

// Files still pending migration to the typed route client. Shrink this list as
// each view is converted; do not add to it.
const ALLOWLIST = new Set([
  'apps/web/src/views/Prospects.tsx',
  'apps/web/src/views/Settings.tsx',
  'apps/web/src/views/Intelligence.tsx',
  'apps/web/src/views/Leads.tsx',
  'apps/web/src/views/Missions.tsx',
  'apps/web/src/views/AiTools.tsx',
  'apps/web/src/views/Approvals.tsx',
  'apps/web/src/views/Billing.tsx',
  'apps/web/src/components/OutreachIntents.tsx',
  'apps/web/src/components/AuthScreen.tsx',
  'apps/web/src/components/GettingStarted.tsx',
  'apps/web/src/components/MissionBuilder.tsx',
  'apps/web/src/components/OnboardingWizard.tsx',
])

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

const offenders = new Set()
for (const file of walk(SRC)) {
  if (PATTERN.test(readFileSync(file, 'utf8'))) {
    offenders.add(relative(ROOT, file).replace(/\\/g, '/'))
  }
}

const newOffenders = [...offenders].filter((f) => !ALLOWLIST.has(f))
const migrated = [...ALLOWLIST].filter((f) => !offenders.has(f))

let failed = false
if (newOffenders.length) {
  failed = true
  console.error('✗ Raw frontend API mutation(s) found outside the typed route client:')
  for (const f of newOffenders) console.error(`    ${f}`)
  console.error('  Route mutations through makeRouteApi (apps/web/src/lib/routeApi.ts).')
}
if (migrated.length) {
  failed = true
  console.error('✗ These files migrated off raw mutations — remove them from ALLOWLIST')
  console.error('  in scripts/check-frontend-mutations.mjs so the ratchet keeps tightening:')
  for (const f of migrated) console.error(`    ${f}`)
}

if (failed) process.exit(1)
console.log(`✓ No new raw frontend mutations (${ALLOWLIST.size} file(s) pending migration to the typed client).`)
