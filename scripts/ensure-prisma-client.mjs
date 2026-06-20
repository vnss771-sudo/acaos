import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const script = join(root, 'scripts/prisma-client.mjs')
const result = spawnSync(process.execPath, [script, 'assert'], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
})

process.exit(result.status ?? 1)
