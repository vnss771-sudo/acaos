import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const requiredFiles = [
  'node_modules/@prisma/client/index.d.ts',
  'node_modules/@prisma/client/index.js',
  'node_modules/.prisma/client/index.d.ts',
  'node_modules/.prisma/client/index.js',
]

const missing = requiredFiles.filter((relativePath) => !existsSync(join(root, relativePath)))

if (missing.length === 0) {
  process.exit(0)
}

console.error([
  '',
  'ACAOS build requires a generated Prisma client before compiling.',
  '',
  'Missing generated files:',
  ...missing.map((path) => `  - ${path}`),
  '',
  'Run one of the following first:',
  '  npm run prisma:generate',
  '  npm ci',
  '',
  'Build intentionally does not call `prisma generate` implicitly anymore,',
  'so builds stay deterministic and do not depend on live engine downloads.',
  '',
].join('\n'))

process.exit(1)
