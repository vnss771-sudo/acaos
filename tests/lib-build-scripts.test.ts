import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const ensureScript = join(root, 'scripts/ensure-prisma-client.mjs')
const postinstallScript = join(root, 'scripts/postinstall.mjs')

function run(script: string, opts: { cwd?: string; env?: Record<string, string> } = {}) {
  return spawnSync(process.execPath, [script], {
    cwd: opts.cwd ?? root,
    env: { ...process.env, ...opts.env },
    encoding: 'utf8',
  })
}

function isolatedScript(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'acaos-script-'))
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  mkdirSync(join(dir, 'packages', 'db', 'prisma', 'offline-client'), { recursive: true })
  cpSync(join(root, 'scripts', name), join(dir, 'scripts', name))
  cpSync(join(root, 'scripts', 'prisma-client.mjs'), join(dir, 'scripts', 'prisma-client.mjs'))
  cpSync(join(root, 'packages', 'db', 'prisma', 'offline-client', 'default.js'), join(dir, 'packages', 'db', 'prisma', 'offline-client', 'default.js'))
  cpSync(join(root, 'packages', 'db', 'prisma', 'offline-client', 'default.d.ts'), join(dir, 'packages', 'db', 'prisma', 'offline-client', 'default.d.ts'))
  return join(dir, 'scripts', name)
}

test('ensure-prisma-client exits 0 when the generated client is present', () => {
  const r = run(ensureScript)
  assert.equal(r.status, 0, r.stderr)
})

test('ensure-prisma-client hydrates the offline stub when the client is missing', () => {
  const r = run(isolatedScript('ensure-prisma-client.mjs'))
  assert.equal(r.status, 0)
  assert.match(r.stdout, /Installed offline Prisma stub/)
})

test('postinstall installs the offline stub when ACAOS_SKIP_PRISMA_POSTINSTALL=1', () => {
  const r = run(postinstallScript, { env: { ACAOS_SKIP_PRISMA_POSTINSTALL: '1' } })
  assert.equal(r.status, 0)
  assert.match(r.stdout, /Skipping Prisma generate during postinstall/)
})

test('postinstall skips cleanly when the schema is not in the install context', () => {
  const r = run(isolatedScript('postinstall.mjs'))
  assert.equal(r.status, 0)
  assert.match(r.stdout, /schema not present/)
})
