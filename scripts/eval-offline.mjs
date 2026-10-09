#!/usr/bin/env node
// Offline AI evaluation: runs every deterministic suite in the versioned
// manifest (eval/datasets/<version>/manifest.json). Needs no provider key and
// makes no network call, so it gates the billed live evals.
//
//   node scripts/eval-offline.mjs [--dataset v1]
import { readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const i = process.argv.indexOf('--dataset')
const version = i > 0 ? process.argv[i + 1] : 'v1'
const manifestPath = `eval/datasets/${version}/manifest.json`
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

const files = manifest.suites.flatMap(s => s.offline)
const missing = files.filter(f => !existsSync(f))
if (missing.length) {
  console.error(`[eval:offline] ${manifestPath} lists missing suites:\n${missing.map(f => ` - ${f}`).join('\n')}`)
  process.exit(1)
}

console.log(`[eval:offline] dataset ${manifest.version}: ${manifest.suites.map(s => `${s.task} (${s.offline.length})`).join(', ')}`)
const run = spawnSync('npx', ['tsx', '--test', ...new Set(files)], {
  stdio: 'inherit',
  env: { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, '--conditions=acaos-src'].filter(Boolean).join(' ') },
})
process.exit(run.status ?? 1)
