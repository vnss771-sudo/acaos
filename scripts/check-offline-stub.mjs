#!/usr/bin/env node
// Guard the hand-maintained offline Prisma stub against drift.
//
// The "deterministic offline build" and "forward-compat" CI jobs compile the code
// against packages/db/prisma/offline-client (a minimal stand-in for the generated
// @prisma/client), used when real generation is skipped/unavailable. Its `Prisma`
// namespace only declares the members the code references; when new code references
// a `Prisma.<Something>` that the stub doesn't declare, those builds fail with
// TS2694 — historically caught only AFTER push. This gate catches it locally in
// `npm run verify` by asserting every `Prisma.<Member>` referenced in stub-compiled
// source is declared in the stub.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const stub = path.join(root, 'packages/db/prisma/offline-client/default.d.ts')
// Directories whose TS is compiled against the offline stub in the offline builds.
const srcDirs = [
  'packages/backend-core/src',
  'apps/api/src',
  'apps/worker/src',
]

function walk(dir) {
  const out = []
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(p))
    else if (entry.isFile() && /\.tsx?$/.test(entry.name)) out.push(p)
  }
  return out
}

// Declared members of the stub's `Prisma` namespace.
const stubSrc = fs.readFileSync(stub, 'utf8')
const declared = new Set()
for (const m of stubSrc.matchAll(/export\s+(?:type|interface|const|function|class|enum)\s+([A-Za-z0-9_]+)/g)) {
  declared.add(m[1])
}

// Referenced `Prisma.<Member>` across stub-compiled source.
const referenced = new Map() // member -> first file:line
for (const dir of srcDirs) {
  for (const file of walk(path.join(root, dir))) {
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/\bPrisma\.([A-Za-z0-9_]+)/g)) {
        if (!referenced.has(m[1])) referenced.set(m[1], `${path.relative(root, file)}:${i + 1}`)
      }
    })
  }
}

const missing = [...referenced.entries()].filter(([name]) => !declared.has(name))
if (missing.length > 0) {
  console.error('✗ Offline Prisma stub is missing members referenced by stub-compiled code:')
  for (const [name, where] of missing) {
    console.error(`  - Prisma.${name}  (first used ${where})`)
  }
  console.error(`\nAdd these to the Prisma namespace in ${path.relative(root, stub)}`)
  console.error('(the offline/forward-compat builds compile against this stub).')
  process.exit(1)
}

console.log(`✓ Offline Prisma stub declares all ${referenced.size} referenced Prisma.* members.`)
