import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const schema = join(root, 'packages/db/prisma/schema.prisma')
const prismaBin = join(root, 'node_modules/.bin/prisma')

function log(message) {
  console.log(`[postinstall] ${message}`)
}

if (process.env.ACAOS_SKIP_PRISMA_POSTINSTALL === '1') {
  log('Skipping Prisma generate (ACAOS_SKIP_PRISMA_POSTINSTALL=1).')
  process.exit(0)
}

if (!existsSync(schema)) {
  log('Skipping Prisma generate: schema not present in this install context.')
  process.exit(0)
}

if (!existsSync(prismaBin)) {
  log('Skipping Prisma generate: Prisma CLI not installed in this dependency set.')
  process.exit(0)
}

log('Generating Prisma client...')
const result = spawnSync(process.execPath, [prismaBin, 'generate', '--schema', schema], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
})

if (result.status !== 0) {
  process.exit(result.status ?? 1)
}

log('Prisma client generated.')
