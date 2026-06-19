#!/usr/bin/env node
// Ratcheting guard against raw, untyped frontend API mutations (A+ review finding
// P1-5). Production frontend code must route mutations through the typed client
// (apps/web/src/lib/routeApi.ts), not hand-build `body: JSON.stringify(...)`, so
// the request shape can never drift from the shared RouteContracts.
//
// This is a RATCHET: ALLOWLIST holds the files that still contain raw mutations
// today (now empty — every view was migrated to the typed route client). CI fails
// if:
//   1. a non-allowlisted, non-exempt file introduces a raw mutation (no backsliding), or
//   2. a file ON the allowlist no longer has any (remove it so the list can't grow stale).
// EXEMPT files are permitted raw fetch by design and are documented below.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const SRC = join(ROOT, 'apps/web/src')
const PATTERN = /body:\s*JSON\.stringify\(/

// Empty: every production view now routes mutations through makeRouteApi. Do not
// add to this — a new raw mutation should be migrated, not allowlisted.
const ALLOWLIST = new Set([])

// Permanent, documented exceptions. These use raw fetch by design and CANNOT go
// through the authenticated route client.
const EXEMPT = new Set([
  // Pre-auth handshake: no bearer token yet, must control credentials/CSRF, and a
  // 401 means bad credentials (not an expired session) — so it must not flow
  // through the authenticated api/route client. Bodies are typed via @acaos/shared.
  'apps/web/src/components/AuthScreen.tsx',
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
  const rel = relative(ROOT, file).replace(/\\/g, '/')
  if (EXEMPT.has(rel)) continue
  if (PATTERN.test(readFileSync(file, 'utf8'))) offenders.add(rel)
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
console.log(`✓ All frontend mutations go through the typed route client (${ALLOWLIST.size} pending, ${EXEMPT.size} documented exemption(s)).`)
