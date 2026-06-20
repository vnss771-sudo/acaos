// A+ guard: the build-determinism scripts the completion pass introduced
// (scripts/ensure-prisma-client.mjs and scripts/postinstall.mjs) had no tests.
// They gate every production build and install, so we pin their contract:
//   - ensure-prisma-client: exit 0 when the client exists, exit 1 (with a clear
//     message) when it doesn't.
//   - postinstall: generate when schema+CLI are present, but SKIP cleanly (exit 0)
//     when told to, or when the schema isn't in the install context (e.g. early
//     Docker layers / prod-only installs) — the exact paths the Docker images and
//     CI rely on.

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

// Copy a script into an isolated temp dir so its `root = <script>/..` resolves to
// a tree WITHOUT a generated client / schema — exercising the missing-prereq paths.
function isolatedScript(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'acaos-script-'))
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  const dest = join(dir, 'scripts', name)
  cpSync(join(root, 'scripts', name), dest)
  return dest
}

test('ensure-prisma-client exits 0 when the generated client is present', () => {
  // The repo's client is generated (prisma:generate runs in the suite's setup).
  const r = run(ensureScript)
  assert.equal(r.status, 0, r.stderr)
})

test('ensure-prisma-client exits 1 with a clear message when the client is missing', () => {
  const r = run(isolatedScript('ensure-prisma-client.mjs'))
  assert.equal(r.status, 1)
  assert.match(r.stderr, /requires a generated Prisma client/)
  assert.match(r.stderr, /npm run prisma:generate/)
})

test('postinstall skips cleanly when ACAOS_SKIP_PRISMA_POSTINSTALL=1', () => {
  const r = run(postinstallScript, { env: { ACAOS_SKIP_PRISMA_POSTINSTALL: '1' } })
  assert.equal(r.status, 0)
  assert.match(r.stdout, /Skipping/)
})

test('postinstall skips cleanly when the schema is not in the install context', () => {
  // Isolated copy has no packages/db/prisma/schema.prisma → must no-op, not fail.
  const r = run(isolatedScript('postinstall.mjs'))
  assert.equal(r.status, 0)
  assert.match(r.stdout, /schema not present/)
})
