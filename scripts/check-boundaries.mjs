#!/usr/bin/env node
// Architectural boundary guard.
//
// The worker must not import API source: shared backend logic lives in
// @acaos/backend-core, which both apps depend on. This check fails CI if the
// worker reaches into apps/api again (directly or via a relative ../api path),
// so the decoupling can't silently regress.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry)) out.push(p)
  }
  return out
}

const violations = []
const workerSrc = join(ROOT, 'apps/worker/src')
// Match imports/requires that reach into the API package, e.g.
//   from '../../api/src/lib/x.js'   |   import('apps/api/...')
const API_IMPORT = /\b(?:from|import|require)\b[^\n]*['"][^'"]*(?:\.\.\/)*(?:apps\/)?api\/src\//

for (const file of walk(workerSrc)) {
  const src = readFileSync(file, 'utf8')
  src.split('\n').forEach((line, i) => {
    if (API_IMPORT.test(line)) {
      violations.push(`${file.replace(ROOT, '')}:${i + 1}: ${line.trim()}`)
    }
  })
}

if (violations.length > 0) {
  console.error('✗ Boundary check failed — apps/worker must not import apps/api (use @acaos/backend-core):')
  for (const v of violations) console.error('  ' + v)
  process.exit(1)
}

console.log('✓ Boundary check passed — worker does not import apps/api.')
