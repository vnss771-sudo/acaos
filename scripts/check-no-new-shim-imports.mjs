#!/usr/bin/env node
// Guard against apps/api/src/lib/ re-export shims ever coming back.
//
// Phase 1 introduced this as a RATCHET against the 23 `export * from
// '@acaos/backend-core/lib/X.js'` shim files that used to live in
// apps/api/src/lib/ (kept only so pre-existing import sites, written before
// that code moved to backend-core, kept resolving). Phase 2 deleted all 23
// shims and repointed every call site at `@acaos/backend-core/lib/X.js`
// directly, so the ratchet is now a hard guarantee instead of an allowlist:
// CI fails if ANY apps/api/src file re-introduces a re-export shim (a local
// `./something.ts` whose entire body is `export * from
// '@acaos/backend-core/lib/...'`) or imports apps/api/src/lib/ code that
// merely forwards to backend-core. New code should always import
// @acaos/backend-core directly — going through a local indirection adds a
// layer with no benefit.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const API_SRC = join(ROOT, 'apps/api/src')
const LIB_DIR = join(API_SRC, 'lib')

const REEXPORT_ONLY = /^\s*(?:\/\/.*\n|\/\*[\s\S]*?\*\/\n)*\s*export\s*\*\s*from\s*['"]@acaos\/backend-core\/lib\/[^'"]+\.js['"]\s*;?\s*$/

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

// 1. No file under apps/api/src/lib/ may be a pure backend-core re-export shim.
const reintroducedShims = []
for (const file of walk(LIB_DIR)) {
  const src = readFileSync(file, 'utf8')
  if (REEXPORT_ONLY.test(src)) reintroducedShims.push(relative(ROOT, file))
}

// 2. No file anywhere in apps/api/src may import such a shim by relative path.
const shimFiles = new Set(reintroducedShims.map((f) => join(ROOT, f)))
const IMPORT_SPEC = /(?:from|require\(|import\()\s*['"](\.[^'"]*)['"]/g

function resolvedShim(importerFile, spec) {
  if (!spec.startsWith('.')) return null
  const withoutExt = spec.replace(/\.js$/, '')
  const resolvedTs = resolve(dirname(importerFile), `${withoutExt}.ts`)
  return shimFiles.has(resolvedTs) ? relative(ROOT, resolvedTs) : null
}

const shimImporters = new Set()
if (shimFiles.size > 0) {
  for (const file of walk(API_SRC)) {
    if (shimFiles.has(file)) continue
    const src = readFileSync(file, 'utf8')
    let match
    IMPORT_SPEC.lastIndex = 0
    while ((match = IMPORT_SPEC.exec(src))) {
      if (resolvedShim(file, match[1])) { shimImporters.add(relative(ROOT, file)); break }
    }
  }
}

let failed = false
if (reintroducedShims.length > 0) {
  failed = true
  console.error('✗ apps/api/src/lib/ re-export shim(s) reintroduced — import @acaos/backend-core directly instead:')
  for (const f of reintroducedShims) console.error(`  ${f}`)
}
if (shimImporters.size > 0) {
  failed = true
  console.error('✗ File(s) importing a re-export shim instead of @acaos/backend-core directly:')
  for (const f of [...shimImporters].sort()) console.error(`  ${f}`)
}

if (failed) process.exit(1)
console.log('✓ No apps/api/src/lib/ re-export shims (all 23 deleted in Phase 2; every call site imports @acaos/backend-core directly).')
