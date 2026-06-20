#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const schema = path.join(root, 'packages/db/prisma/schema.prisma')
const prismaBin = path.join(root, 'node_modules/.bin/prisma')
const stubSource = path.join(root, 'packages/db/prisma/offline-client')
const generatedRoots = [
  path.join(root, 'node_modules/@prisma/client/.prisma/client'),
  path.join(root, 'node_modules/.prisma/client'),
]

function log(message) {
  console.log(`[prisma-client] ${message}`)
}

function copyDir(from, to) {
  fs.rmSync(to, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.cpSync(from, to, { recursive: true })
}

function hasClient() {
  return generatedRoots.some((dir) =>
    fs.existsSync(path.join(dir, 'default.js')) &&
    fs.existsSync(path.join(dir, 'default.d.ts')),
  )
}

function writeMarker(dir, details) {
  fs.writeFileSync(path.join(dir, 'offline-stub.json'), `${JSON.stringify(details, null, 2)}\n`)
}

// A real `prisma generate` overwrites default.js/default.d.ts but leaves any
// prior offline-stub marker behind, which would misreport the client as a stub.
// Clear the markers whenever a real client is in place so state stays truthful.
function clearStubMarkers() {
  for (const dir of generatedRoots) {
    fs.rmSync(path.join(dir, 'offline-stub.json'), { force: true })
  }
}

function installOfflineStub(reason) {
  const details = {
    mode: 'offline-stub',
    reason,
    installedAt: new Date().toISOString(),
  }
  for (const dir of generatedRoots) {
    copyDir(stubSource, dir)
    writeMarker(dir, details)
  }
  log('Installed offline Prisma stub.')
}

function runGenerate() {
  if (!fs.existsSync(schema)) {
    log('Skipping Prisma client generation: schema not present in this install context.')
    return true
  }
  if (!fs.existsSync(prismaBin)) {
    log('Skipping Prisma client generation: Prisma CLI not installed in this dependency set.')
    return true
  }
  log('Generating Prisma client...')
  const result = spawnSync(process.execPath, [prismaBin, 'generate', '--schema', schema], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  })
  return (result.status ?? 1) === 0
}

const command = process.argv[2] ?? 'generate'

if (command === 'assert') {
  if (hasClient()) process.exit(0)
  installOfflineStub('Client missing at build/typecheck time.')
  process.exit(0)
}

if (command !== 'generate') {
  console.error(`Unknown command: ${command}`)
  process.exit(1)
}

if (process.env.ACAOS_SKIP_PRISMA_POSTINSTALL === '1') {
  log('Skipping Prisma generate during postinstall (ACAOS_SKIP_PRISMA_POSTINSTALL=1).')
  installOfflineStub('Postinstall generation explicitly skipped.')
  process.exit(0)
}

const ok = runGenerate()
if (ok && hasClient()) {
  clearStubMarkers()
  log('Prisma client ready.')
  process.exit(0)
}

installOfflineStub('Prisma generate failed or produced no client (restricted/offline environment).')
process.exit(0)
