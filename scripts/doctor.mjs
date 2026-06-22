#!/usr/bin/env node
// Local developer preflight: a fast, dependency-free snapshot of whether this
// checkout is ready to run the heavier gates (lint/typecheck/test/build) and the
// app. Checks Node/npm versions, workspace presence, install state, .env, the
// Prisma client mode, and the key service env vars. Read-only; never mutates.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = process.cwd()
const checks = []
const add = (status, label, detail = '') => checks.push({ status, label, detail })

const major = (version) => {
  const match = /^v?(\d+)/.exec(version.trim())
  return match ? Number(match[1]) : 0
}
const commandVersion = (command, args = ['--version']) => {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : ''
}
const hasEnv = (name) => Boolean(process.env[name] && process.env[name]?.trim())

const nodeMajor = major(process.version)
add(nodeMajor >= 22 ? 'ok' : 'fail', 'Node.js runtime', `${process.version} ${nodeMajor >= 22 ? '(>=22)' : '(requires >=22)'}`)

const npmVersion = commandVersion('npm')
const npmMajor = major(npmVersion)
add(npmMajor >= 10 ? 'ok' : 'warn', 'npm CLI', npmVersion ? `${npmVersion} ${npmMajor >= 10 ? '(>=10)' : '(recommended >=10)'}` : 'npm not found')

for (const dir of ['apps/api', 'apps/web', 'apps/worker', 'packages/backend-core', 'packages/db', 'packages/shared']) {
  const present = existsSync(join(root, dir, 'package.json'))
  add(present ? 'ok' : 'fail', `workspace ${dir}`, present ? 'present' : 'missing package.json')
}

add(existsSync(join(root, 'node_modules')) ? 'ok' : 'warn', 'dependencies', existsSync(join(root, 'node_modules')) ? 'node_modules present' : 'run npm install')
add(existsSync(join(root, '.env')) ? 'ok' : 'warn', 'local .env', existsSync(join(root, '.env')) ? '.env present' : 'copy .env.example to .env for local services')

// Prisma client mode: a real generate writes default.js and clears the
// offline-stub.json marker; the offline fallback (no network for the engine
// download) leaves that marker behind. Mirror the canonical detection used by
// scripts/assert-real-prisma-client.mjs rather than sniffing file contents.
const generatedRoots = [
  join(root, 'node_modules/@prisma/client/.prisma/client'),
  join(root, 'node_modules/.prisma/client'),
]
const realClient = generatedRoots.some(
  (dir) => existsSync(join(dir, 'default.js')) && !existsSync(join(dir, 'offline-stub.json')),
)
const stubInstalled = generatedRoots.some((dir) => existsSync(join(dir, 'offline-stub.json')))
if (realClient) add('ok', 'Prisma client', 'generated client present')
else if (stubInstalled) add('warn', 'Prisma client', 'offline stub installed; run npm run prisma:generate in a networked environment for real DB access')
else add('warn', 'Prisma client', 'not generated yet; run npm run prisma:generate')

add(hasEnv('DATABASE_URL') ? 'ok' : 'warn', 'DATABASE_URL', hasEnv('DATABASE_URL') ? 'set' : 'required for API DB access and npm run test:db')
add(hasEnv('REDIS_URL') ? 'ok' : 'warn', 'REDIS_URL', hasEnv('REDIS_URL') ? 'set' : 'required for worker queues and npm run test:redis')
add(hasEnv('JWT_SECRET') ? 'ok' : 'warn', 'JWT_SECRET', hasEnv('JWT_SECRET') ? 'set' : 'required in production; development can use an ephemeral secret')

const icons = { ok: '✓', warn: '!', fail: '✗' }
console.log('ACAOS project doctor\n')
for (const check of checks) console.log(`${icons[check.status]} ${check.label}: ${check.detail}`)

const failures = checks.filter((c) => c.status === 'fail')
const warnings = checks.filter((c) => c.status === 'warn')
console.log(`\nSummary: ${checks.length - failures.length - warnings.length} ok, ${warnings.length} warning(s), ${failures.length} failure(s).`)

// Make the offline-stub state impossible to miss: a green typecheck/build on the
// stub does NOT prove the code compiles against the real Prisma client, so local
// release confidence can be overstated. Call it out loudly and point at the gate.
if (stubInstalled && !realClient) {
  console.log(
    '\n⚠️  Prisma OFFLINE STUB is installed (not the real generated client).\n' +
    '    typecheck/build can pass against the `any`-typed stub and still hide real\n' +
    '    schema/type drift. Before trusting a release: run `npm run prisma:generate`\n' +
    '    in a networked environment, then `npm run check:prisma-real` (or the full\n' +
    '    `npm run verify:release`, which asserts the real client first).'
  )
}

if (failures.length > 0) {
  console.log('\nFix failure(s) before running verify/build gates.')
  process.exit(1)
}
console.log('\nNext useful gates: npm run lint && npm run typecheck && npm test && npm run test:web && npm run build')
