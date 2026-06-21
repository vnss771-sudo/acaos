#!/usr/bin/env node
// Guard for the production docker-compose runtime hardening (security review
// finding #14). CI never runs `docker compose up`, so without this check the
// hardening could silently regress. We assert, per service, that the production
// stack (docker-compose.yml) keeps:
//   - all services: no-new-privileges + a memory limit (can't escalate, can't
//     starve the host),
//   - the stateless app services (api, worker, web): a read-only root filesystem
//     and all Linux capabilities dropped.
// The dev stack (docker-compose.local.yml) is intentionally exempt — it bind-mounts
// the repo and runs npm install, so it must stay writable.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const FILE = 'docker-compose.yml'
const text = readFileSync(join(ROOT, FILE), 'utf8')

// Slice the file into top-level service blocks (keys indented exactly two spaces
// under `services:`). Each block runs until the next 2-space key or a top-level
// key (e.g. `volumes:`).
function serviceBlocks(src) {
  const lines = src.split('\n')
  const blocks = {}
  let current = null
  let buf = []
  const flush = () => { if (current) blocks[current] = buf.join('\n'); buf = [] }
  let inServices = false
  for (const line of lines) {
    if (/^services:\s*$/.test(line)) { inServices = true; continue }
    if (!inServices) continue
    const svc = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/)
    if (svc) { flush(); current = svc[1]; continue }
    if (/^\S/.test(line)) { flush(); current = null; inServices = false; continue }
    if (current) buf.push(line)
  }
  flush()
  return blocks
}

const blocks = serviceBlocks(text)

const ALL_SERVICES = ['postgres', 'redis', 'api', 'worker', 'web']
const STATELESS_APPS = ['api', 'worker', 'web']

const errors = []
const has = (block, re) => re.test(block)

for (const name of ALL_SERVICES) {
  const block = blocks[name]
  if (!block) { errors.push(`${FILE}: missing service "${name}"`); continue }
  if (!has(block, /no-new-privileges:true/)) errors.push(`${name}: missing security_opt no-new-privileges:true`)
  if (!has(block, /memory:\s*\S+/)) errors.push(`${name}: missing deploy.resources.limits.memory`)
}

for (const name of STATELESS_APPS) {
  const block = blocks[name]
  if (!block) continue
  if (!has(block, /read_only:\s*true/)) errors.push(`${name}: stateless app must set read_only: true`)
  if (!has(block, /cap_drop:/) || !has(block, /-\s*ALL\b/)) errors.push(`${name}: stateless app must cap_drop: [ALL]`)
  if (!has(block, /tmpfs:/)) errors.push(`${name}: read-only root needs a tmpfs mount (at least /tmp)`)
}

if (errors.length) {
  console.error('✗ docker-compose runtime hardening regressed:')
  for (const e of errors) console.error(`    ${e}`)
  console.error('  See security review finding #14 / scripts/check-compose-hardening.mjs.')
  process.exit(1)
}
console.log(`✓ Compose runtime hardening present for ${ALL_SERVICES.length} services (read-only root + dropped caps on ${STATELESS_APPS.length} app services).`)
