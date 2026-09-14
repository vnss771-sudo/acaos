#!/usr/bin/env node
// Ratcheting guard against NEW imports of the apps/api/src/lib/ re-export
// shims — thin `export * from '@acaos/backend-core/lib/X.js'` files kept only
// so pre-existing import sites (written before that code moved to
// backend-core) keep resolving. New code should import @acaos/backend-core
// directly; going through a shim adds an indirection with no benefit.
//
// Deleting all 23 shims and repointing every existing call site (~100+ across
// apps/api) in one pass was judged too large/risky for this change — tracked
// as a follow-up. This is the interim guard-rail: a RATCHET, like
// check-frontend-mutations.mjs's pattern. ALLOWLIST holds every file that
// already imports a shim today. CI fails if:
//   1. a non-allowlisted file introduces a NEW shim import (no backsliding), or
//   2. a file ON the allowlist no longer imports any shim (prune it — keeps
//      the list from silently drifting into dead entries).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const API_SRC = join(ROOT, 'apps/api/src')
const LIB_DIR = join(API_SRC, 'lib')

// The 23 pure re-export shims (export * from '@acaos/backend-core/lib/X.js'),
// identified by basename (no extension) under apps/api/src/lib/.
const SHIM_NAMES = new Set([
  'audit', 'circuit', 'config', 'encrypt', 'env', 'errorReporting',
  'fetchWithTimeout', 'jwt', 'learningLoop', 'limits', 'logger',
  'observability', 'outreachIntent', 'prisma', 'prospectSources',
  'providerClient', 'queues', 'recommendationPolicy', 'scoring',
  'signalEngine', 'signalIngest', 'ssrf', 'suppressions',
])
const SHIM_FILES = new Set([...SHIM_NAMES].map((n) => join(LIB_DIR, `${n}.ts`)))

// Every relative-path file that currently imports one of the shims above.
// Snapshot as of the guard-rail's introduction — do not add to it; a new call
// site should import @acaos/backend-core directly instead.
const ALLOWLIST = new Set([
  'apps/api/src/lib/health.ts',
  'apps/api/src/lib/http.ts',
  'apps/api/src/lib/materializeIntent.ts',
  'apps/api/src/lib/packs/types.ts',
  'apps/api/src/lib/sendReadiness.ts',
  'apps/api/src/lib/workspaces.ts',
  'apps/api/src/middleware/auth.ts',
  'apps/api/src/middleware/requestContext.ts',
  'apps/api/src/middleware/securityHeaders.ts',
  'apps/api/src/routes/admin.ts',
  'apps/api/src/routes/ai.ts',
  'apps/api/src/routes/auth.ts',
  'apps/api/src/routes/billing.ts',
  'apps/api/src/routes/campaigns.ts',
  'apps/api/src/routes/inbox.ts',
  'apps/api/src/routes/ingest.ts',
  'apps/api/src/routes/intelligence.ts',
  'apps/api/src/routes/jobs.ts',
  'apps/api/src/routes/leads.ts',
  'apps/api/src/routes/mailbox.ts',
  'apps/api/src/routes/missions.ts',
  'apps/api/src/routes/ops/admin.ts',
  'apps/api/src/routes/ops/alerts.ts',
  'apps/api/src/routes/ops/clock.ts',
  'apps/api/src/routes/ops/crew.ts',
  'apps/api/src/routes/ops/fatigue.ts',
  'apps/api/src/routes/ops/jobs.ts',
  'apps/api/src/routes/ops/roster.ts',
  'apps/api/src/routes/ops/shifts.ts',
  'apps/api/src/routes/ops/utils.ts',
  'apps/api/src/routes/outcomes.ts',
  'apps/api/src/routes/packs.ts',
  'apps/api/src/routes/prospects/crud.ts',
  'apps/api/src/routes/prospects/discovery.ts',
  'apps/api/src/routes/prospects/enrichment.ts',
  'apps/api/src/routes/prospects/helpers.ts',
  'apps/api/src/routes/prospects/intents.ts',
  'apps/api/src/routes/prospects/scoring.ts',
  'apps/api/src/routes/sends.ts',
  'apps/api/src/routes/signals.ts',
  'apps/api/src/routes/stats.ts',
  'apps/api/src/routes/unsubscribe.ts',
  'apps/api/src/routes/webhooks.ts',
  'apps/api/src/routes/workspaces/apiKeys.ts',
  'apps/api/src/routes/workspaces/compliance.ts',
  'apps/api/src/routes/workspaces/core.ts',
  'apps/api/src/routes/workspaces/emailConfig.ts',
  'apps/api/src/routes/workspaces/helpers.ts',
  'apps/api/src/routes/workspaces/icp.ts',
  'apps/api/src/routes/workspaces/members.ts',
  'apps/api/src/server.ts',
  'apps/api/src/services/apollo.ts',
  'apps/api/src/services/hunter.ts',
  'apps/api/src/services/stripe.ts',
])

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

const IMPORT_SPEC = /(?:from|require\()\s*['"](\.[^'"]*)['"]/g

function resolvedShimName(importerFile, spec) {
  if (!spec.startsWith('.')) return null
  const withoutExt = spec.replace(/\.js$/, '')
  const resolvedTs = resolve(dirname(importerFile), `${withoutExt}.ts`)
  return SHIM_FILES.has(resolvedTs) ? relative(LIB_DIR, resolvedTs).replace(/\.ts$/, '') : null
}

const offenders = new Set()
for (const file of walk(API_SRC)) {
  // The shims' own re-export lines (`export * from '@acaos/backend-core/...'`)
  // live IN these files — they are not imports of themselves.
  if (SHIM_FILES.has(file)) continue

  const src = readFileSync(file, 'utf8')
  let match
  let usesShim = false
  IMPORT_SPEC.lastIndex = 0
  while ((match = IMPORT_SPEC.exec(src))) {
    if (resolvedShimName(file, match[1])) { usesShim = true; break }
  }
  if (usesShim) offenders.add(relative(ROOT, file))
}

const newOffenders = [...offenders].filter((f) => !ALLOWLIST.has(f)).sort()
const staleAllowlist = [...ALLOWLIST].filter((f) => !offenders.has(f)).sort()

let failed = false
if (newOffenders.length > 0) {
  failed = true
  console.error('✗ New import(s) of an apps/api/src/lib/ re-export shim — import @acaos/backend-core directly instead:')
  for (const f of newOffenders) console.error(`  ${f}`)
}
if (staleAllowlist.length > 0) {
  failed = true
  console.error('✗ ALLOWLIST entries no longer import any shim — remove them from scripts/check-no-new-shim-imports.mjs:')
  for (const f of staleAllowlist) console.error(`  ${f}`)
}

if (failed) process.exit(1)
console.log(`✓ No new backend-core shim imports (${offenders.size} pre-existing, allowlisted call sites unchanged).`)
