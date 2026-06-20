#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'dist-pack')
const out = join(outDir, 'acaos-source.zip')
const manifest = join(outDir, 'release-manifest.json')

mkdirSync(outDir, { recursive: true })

execFileSync(process.execPath, [
  join(root, 'scripts/release-metadata.mjs'),
  '--manifest',
  manifest,
], { cwd: root, stdio: 'inherit' })

execFileSync(
  'git',
  ['archive', '--format=zip', '--prefix=acaos/', '-o', out, 'HEAD'],
  { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] },
)

const mb = (statSync(out).size / 1024 / 1024).toFixed(2)
console.log(`\n✓ Wrote ${out} (${mb} MB) — tracked files only, extracts to acaos/`)
console.log(`✓ Wrote ${manifest}`)
console.log('  Build it with the steps in BUILD.md (npm install → prisma:generate → build).')
