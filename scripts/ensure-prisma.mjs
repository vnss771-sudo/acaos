#!/usr/bin/env node
// Ensure the Prisma client is generated before typecheck/test/build.
//
// Clean `npm test` / `npm run typecheck` need the generated client (backend-core
// imports @prisma/client). This makes those paths self-healing without forcing a
// regenerate on every run: it generates ONLY when the client is missing, so it's
// a fast no-op once present (and in CI, which generates explicitly).

import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const client = join(root, 'node_modules', '.prisma', 'client', 'index.js')

if (existsSync(client)) process.exit(0)

console.log('[ensure-prisma] generated client missing — running prisma:generate…')
try {
  execFileSync('npm', ['run', 'prisma:generate'], { cwd: root, stdio: 'inherit' })
} catch {
  console.error(
    '\n[ensure-prisma] prisma generate failed. Generate the client before continuing:\n' +
    '  npm run prisma:generate\n' +
    '(needs network access to fetch Prisma engines on first run).',
  )
  process.exit(1)
}
