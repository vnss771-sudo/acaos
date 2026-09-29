#!/usr/bin/env node
// Guard against backend-core re-export shims in apps/api/src.
//
// CI fails if any apps/api/src file is a pure re-export shim (its entire body is
// `export * from '@acaos/backend-core/...'`) or imports one by relative path.
// Code should import @acaos/backend-core directly — a local forwarding file
// adds a layer with no benefit.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const API_SRC = join(ROOT, 'apps/api/src')

// The statement a pure re-export shim's body must reduce to once any leading
// comments are stripped. Deliberately simple (one line, no repeated
// alternation) — see isPureReexportShim below for why comment-stripping is
// done as a plain line scan rather than folded into this regex.
const REEXPORT_STATEMENT = /^export\s*\*\s*from\s*['"]@acaos\/backend-core\/(?:lib|services)\/[^'"]+\.js['"]\s*;?$/

// True when `src`, once its leading //-comments and /* */-comments are
// stripped, is nothing but a single `export * from '@acaos/backend-core/lib/
// X.js'` statement. Strips comments with a plain per-line scan rather than a
// regex whose comment-matching alternation repeats an unbounded number of
// times (CodeQL flagged the previous version of this check as vulnerable to
// catastrophic backtracking on crafted input) — this file's content is
// first-party source under CI's control, not attacker input, but a linear
// line scan is both safer and no harder to read than the regex it replaces.
function isPureReexportShim(src) {
  const lines = src.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i].trim()
    if (line === '' || line.startsWith('//')) { i++; continue }
    if (line.startsWith('/*')) {
      while (i < lines.length && !lines[i].includes('*/')) i++
      i++
      continue
    }
    break
  }
  return REEXPORT_STATEMENT.test(lines.slice(i).join('\n').trim())
}

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

// 1. No file under apps/api/src may be a pure backend-core re-export shim.
const reintroducedShims = []
for (const file of walk(API_SRC)) {
  const src = readFileSync(file, 'utf8')
  if (isPureReexportShim(src)) reintroducedShims.push(relative(ROOT, file))
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
  console.error('✗ apps/api/src re-export shim(s) found — import @acaos/backend-core directly instead:')
  for (const f of reintroducedShims) console.error(`  ${f}`)
}
if (shimImporters.size > 0) {
  failed = true
  console.error('✗ File(s) importing a re-export shim instead of @acaos/backend-core directly:')
  for (const f of [...shimImporters].sort()) console.error(`  ${f}`)
}

if (failed) process.exit(1)
console.log('✓ No re-export shims in apps/api/src; every call site imports @acaos/backend-core directly.')
