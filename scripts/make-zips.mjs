#!/usr/bin/env node
// Produce a clean source archive of the repo — tracked files only (no
// node_modules, dist, .env, or .git), via `git archive`. Output: dist-pack/.
//
//   npm run pack    →  dist-pack/acaos-source.zip
//
// The archive reflects committed HEAD, so commit before packing to include
// your latest changes.

import { execFileSync } from 'node:child_process'
import { mkdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'dist-pack')
const out = join(outDir, 'acaos-source.zip')

mkdirSync(outDir, { recursive: true })

execFileSync(
  'git',
  ['archive', '--format=zip', '--prefix=acaos/', '-o', out, 'HEAD'],
  { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] },
)

const mb = (statSync(out).size / 1024 / 1024).toFixed(2)
console.log(`\n✓ Wrote ${out} (${mb} MB) — tracked files only, extracts to acaos/`)
console.log('  Build it with the steps in BUILD.md (npm install → prisma:generate → build).')
