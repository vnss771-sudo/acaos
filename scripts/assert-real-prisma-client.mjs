#!/usr/bin/env node
// Guard for the typecheck gate: fail if the generated Prisma client is the
// offline stub (or missing) rather than a real generated client.
//
// Why: scripts/prisma-client.mjs intentionally falls back to a checked-in
// offline stub when `prisma generate` can't run (no network for the engine
// download). That stub types PrismaClient as `{ [key: string]: any }`, so a
// typecheck run against it passes even when there are real Prisma type errors —
// the gate silently stops gating. CI typecheck has network and must run against
// the genuine generated types; this asserts that invariant so an environment
// that degraded to the stub fails loudly instead of green-washing typecheck.
//
// Not part of `npm run verify` on purpose: local/offline `verify` is allowed to
// run against the stub. This guard is wired into the CI typecheck job, which is
// expected to be networked.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const generatedRoots = [
  path.join(root, 'node_modules/@prisma/client/.prisma/client'),
  path.join(root, 'node_modules/.prisma/client'),
]

// A real client has default.js + default.d.ts and NO offline-stub marker
// (scripts/prisma-client.mjs writes offline-stub.json when it installs the stub
// and clears it after a successful real generate).
function isRealClient(dir) {
  return (
    fs.existsSync(path.join(dir, 'default.js')) &&
    fs.existsSync(path.join(dir, 'default.d.ts')) &&
    !fs.existsSync(path.join(dir, 'offline-stub.json'))
  )
}

const stubMarkerPresent = generatedRoots.some((dir) =>
  fs.existsSync(path.join(dir, 'offline-stub.json')),
)
const realClientPresent = generatedRoots.some(isRealClient)

if (stubMarkerPresent || !realClientPresent) {
  console.error(
    '[assert-prisma] The generated Prisma client is the offline stub (or missing).\n' +
      'Typecheck would run against an `any`-typed PrismaClient and could silently\n' +
      'mask real Prisma type errors, so this gate refuses to proceed.\n' +
      'Run `npm run prisma:generate` in a NETWORKED environment before typecheck.',
  )
  process.exit(1)
}

console.log('[assert-prisma] Real Prisma client present — typecheck will run against genuine types.')
