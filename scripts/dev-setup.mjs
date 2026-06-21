#!/usr/bin/env node
// One-command local bootstrap (review follow-up): take a fresh clone to a
// ready-to-run state. Idempotent and safe to re-run.
//
//   npm run dev:setup
//
// Steps: ensure .env exists → start Postgres + Redis (docker-compose.local.yml)
// → generate the Prisma client → apply migrations → print a doctor snapshot.
// It deliberately does NOT start the app servers — run dev:api / dev:web /
// dev:worker in separate terminals afterwards.
import { existsSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const step = (msg) => console.log(`\n▶ ${msg}`)
const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { cwd: root, stdio: 'inherit', encoding: 'utf8', ...opts })
const ok = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'ignore' })
  return r.status === 0
}

// 1. .env
step('Ensuring .env exists')
const envPath = join(root, '.env')
if (existsSync(envPath)) {
  console.log('  .env already present — leaving it untouched.')
} else if (existsSync(join(root, '.env.example'))) {
  copyFileSync(join(root, '.env.example'), envPath)
  console.log('  Created .env from .env.example. Review it and set any required secrets.')
} else {
  console.log('  ! No .env.example found — skipping. Configure .env manually.')
}

// 2. Docker services
step('Starting local Postgres + Redis (docker-compose.local.yml)')
const dockerOk = ok('docker', ['--version'])
const composeOk = dockerOk && ok('docker', ['compose', 'version'])
let servicesUp = false
if (!dockerOk) {
  console.log('  ! Docker not found. Install Docker, or point DATABASE_URL/REDIS_URL at your own services, then re-run.')
} else if (!composeOk) {
  console.log('  ! `docker compose` not available (need Compose v2). Skipping service startup.')
} else {
  // --wait blocks until the healthchecks pass; only the data services are needed.
  const up = run('docker', ['compose', '-f', 'docker-compose.local.yml', 'up', '-d', '--wait', 'postgres', 'redis'])
  servicesUp = up.status === 0
  if (!servicesUp) console.log('  ! Could not start services (is the Docker daemon running?). Continuing.')
}

// 3. Prisma client
step('Generating the Prisma client')
run('npm', ['run', 'prisma:generate'])

// 4. Migrations (only attempt if the DB is reachable)
if (servicesUp) {
  step('Applying database migrations')
  const migrated = run('npx', ['prisma', 'migrate', 'deploy', '--schema', 'packages/db/prisma/schema.prisma'])
  if (migrated.status !== 0) console.log('  ! Migrations failed — check DATABASE_URL in .env.')
} else {
  console.log('\n▶ Skipping migrations (Postgres not started by this script).')
}

// 5. Doctor snapshot
step('Project doctor')
run('node', ['scripts/doctor.mjs'])

console.log('\n✓ dev:setup complete. Next, in separate terminals:')
console.log('    npm run dev:api')
console.log('    npm run dev:web')
console.log('    npm run dev:worker')
