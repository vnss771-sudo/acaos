#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, relative } from 'node:path'

const root = process.cwd()
const failures = []
const read = (p) => readFileSync(resolve(root, p), 'utf8')

// Acquisition paths must pass through the canonical policy immediately before
// dispatch. These source checks are deliberately conservative drift detectors:
// if the implementation shape changes, security review is required.
for (const [file, needles] of [
  ['apps/worker/src/processors.ts', [
    "context: 'campaign'",
    "context: 'followup'",
    'authorizeOutboundSend({',
    'sendMailFn(',
  ]],
  ['apps/api/src/routes/inbox.ts', [
    "context: 'reply'",
    'authorizeOutboundSend({',
    'sendMailFn(',
  ]],
]) {
  const src = read(file)
  for (const needle of needles) if (!src.includes(needle)) failures.push(`${file}: missing ${needle}`)
}

// The authorization service itself must produce an audit trail without storing
// message content/recipient addresses in AuditEvent metadata.
{
  const file = 'packages/backend-core/src/services/sendAuthorization.ts'
  const src = read(file)
  for (const needle of [
    "type: decision.allowed ? 'send.authorization.allowed' : 'send.authorization.denied'",
    'policyVersion: decision.policyVersion',
    'context: input.context',
    'recordAudit({',
  ]) if (!src.includes(needle)) failures.push(`${file}: missing audit contract ${needle}`)
}

// Direct use of the low-level mail service is security-sensitive. Pin the
// currently reviewed call-site surface so a new outbound path cannot quietly
// appear without updating this checker and receiving explicit review.
const allowedDirectMailCalls = new Map([
  ['apps/api/src/routes/auth.ts', 2],                 // auth transactional mail
  ['apps/api/src/routes/billing.ts', 1],              // billing notification
  ['apps/api/src/routes/workspaces/members.ts', 1],   // workspace invite
  ['apps/api/src/routes/mailbox.ts', 1],              // explicit mailbox test send
  ['apps/api/src/routes/inbox.ts', 1],                // human acquisition reply — policy guarded above
  ['apps/worker/src/processors.ts', 2],                // campaign + follow-up — policy guarded above
])

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const abs = resolve(dir, name)
    const st = statSync(abs)
    if (st.isDirectory()) out.push(...walk(abs))
    else if (name.endsWith('.ts')) out.push(abs)
  }
  return out
}

const scanRoots = ['apps/api/src', 'apps/worker/src']
const observed = new Map()
for (const scanRoot of scanRoots) {
  for (const abs of walk(resolve(root, scanRoot))) {
    const file = relative(root, abs).replaceAll('\\', '/')
    const src = readFileSync(abs, 'utf8')
    if (!src.includes("@acaos/backend-core/services/mail.js")) continue
    const count = (src.match(/\b(?:sendMail|sendMailFn)\s*\(/g) ?? []).length
    if (count > 0) observed.set(file, count)
  }
}
for (const [file, count] of observed) {
  if (!allowedDirectMailCalls.has(file)) failures.push(`${file}: unreviewed direct mail-service call site (${count})`)
  else if (allowedDirectMailCalls.get(file) !== count) failures.push(`${file}: direct mail-call count changed: expected ${allowedDirectMailCalls.get(file)}, found ${count}`)
}
for (const [file, count] of allowedDirectMailCalls) {
  if (!observed.has(file)) failures.push(`${file}: reviewed direct mail call site disappeared or import shape changed (expected ${count})`)
}

// Provider dispatch is centralized in mail.ts. No route/worker should construct a
// Nodemailer transport or call transporter.sendMail directly.
for (const scanRoot of scanRoots) {
  for (const abs of walk(resolve(root, scanRoot))) {
    const file = relative(root, abs).replaceAll('\\', '/')
    const src = readFileSync(abs, 'utf8')
    if (/\btransporter\.sendMail\s*\(/.test(src) || /graph\.microsoft\.com\/v1\.0\/me\/sendMail/.test(src)) {
      failures.push(`${file}: direct provider dispatch bypasses packages/backend-core/src/services/mail.ts`)
    }
  }
}

if (failures.length) {
  console.error('Send authorization boundary check FAILED')
  for (const f of failures) console.error(` - ${f}`)
  process.exit(1)
}
console.log('Send authorization boundary check passed')
console.log(' - campaign, follow-up and human reply paths use authorizeOutboundSend')
console.log(' - authorization decisions are audit-recorded')
console.log(' - direct mail-service call-site inventory has not drifted')
console.log(' - provider dispatch remains centralized in mail.ts')
