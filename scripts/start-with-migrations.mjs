#!/usr/bin/env node
/**
 * Safe production startup for the API.
 *
 * Replaces the dangerous `prisma db push --accept-data-loss` start command —
 * which can silently DROP columns/constraints on a schema change — with proper
 * versioned migrations:
 *
 *   1. Acquire a Postgres advisory lock so only ONE replica runs migrations
 *      even during a rolling deploy / scale-out event. Other replicas wait up
 *      to LOCK_TIMEOUT_MS, then proceed (Prisma's own internal lock still
 *      prevents concurrent applies — this outer lock avoids the health-check
 *      timeout race that can kill a container waiting on Prisma's lock).
 *   2. `prisma migrate deploy` (applies only pending, reviewed migrations).
 *   3. One-time auto-baseline: if the database was originally created with
 *      `db push` (no migration history) Prisma raises P3005 on a non-empty DB.
 *      We then mark the existing migrations as already-applied — ledger only,
 *      never touches table data — and retry.
 *   4. Start the server. If migrations cannot be applied, we EXIT NON-ZERO
 *      and do NOT start: a half-migrated API is worse than a failed deploy.
 *
 * Set the platform start command to:  node scripts/start-with-migrations.mjs
 */
import { execFileSync, spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'

const SCHEMA = 'packages/db/prisma/schema.prisma'
const SERVER = 'apps/api/dist/server.js'
const MIGRATIONS_DIR = 'packages/db/prisma/migrations'
const LOCK_TIMEOUT_MS = 60_000
// Stable integer key for the advisory lock — avoids collisions with app locks
const ADVISORY_LOCK_KEY = 1_234_567_890

function prisma(args) {
  return execFileSync('npx', ['prisma', ...args], { encoding: 'utf8' })
}

function migrateDeploy() {
  try {
    process.stdout.write(prisma(['migrate', 'deploy', '--schema', SCHEMA]))
    return { ok: true, output: '' }
  } catch (err) {
    const output = `${err.stdout || ''}${err.stderr || ''}`
    process.stdout.write(output)
    return { ok: false, output }
  }
}

function listMigrations() {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
}

function baseline() {
  const migrations = listMigrations()
  console.log(`[startup] baselining ${migrations.length} existing migrations as applied (ledger only)…`)
  for (const name of migrations) {
    try {
      prisma(['migrate', 'resolve', '--applied', name, '--schema', SCHEMA])
      console.log(`[startup]   ✓ ${name}`)
    } catch (err) {
      const output = `${err.stdout || ''}${err.stderr || ''}`
      if (/already recorded|is already applied|P3008/i.test(output)) {
        console.log(`[startup]   • ${name} (already applied)`)
        continue
      }
      console.error(`[startup] baseline failed at ${name}:\n${output}`)
      process.exit(1)
    }
  }
}

async function withMigrationLock(fn) {
  // Use the Prisma client (available in the runtime image) to acquire a
  // Postgres session-level advisory lock before running migrations, so
  // concurrent containers in a rolling deploy take turns rather than racing.
  // The whole block is fail-open: if we can't connect or lock, we proceed and
  // rely on Prisma's own internal migration lock for correctness.
  let prismaClient
  try {
    const { PrismaClient } = await import('@prisma/client')
    prismaClient = new PrismaClient()
    await prismaClient.$connect()

    const deadline = Date.now() + LOCK_TIMEOUT_MS
    let locked = false
    while (Date.now() < deadline) {
      const rows = await prismaClient.$queryRaw`SELECT pg_try_advisory_lock(${ADVISORY_LOCK_KEY}::bigint) AS ok`
      if (rows[0]?.ok) { locked = true; break }
      console.log('[startup] waiting for migration lock (another replica is migrating)…')
      await new Promise(r => setTimeout(r, 2000))
    }
    if (!locked) {
      console.warn('[startup] migration lock timeout — proceeding anyway (Prisma serializes internally).')
    }
  } catch (err) {
    console.warn(`[startup] advisory lock unavailable (${err.message}) — proceeding without distributed lock.`)
  }

  try {
    await fn()
  } finally {
    try {
      if (prismaClient) {
        await prismaClient.$executeRaw`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY}::bigint)`.catch(() => {})
        await prismaClient.$disconnect().catch(() => {})
      }
    } catch { /* ignore cleanup errors */ }
  }
}

await withMigrationLock(async () => {
  console.log('[startup] applying database migrations…')
  let res = migrateDeploy()

  if (!res.ok && /P3005|database schema is not empty/i.test(res.output)) {
    console.log('[startup] non-empty database with no migration history — baselining once.')
    baseline()
    res = migrateDeploy()
  }

  if (!res.ok) {
    console.error('[startup] migrations failed — refusing to start with an unmigrated database.')
    process.exit(1)
  }

  console.log('[startup] database up to date.')
})

console.log(`[startup] starting API (${SERVER}).`)
const child = spawn('node', [SERVER], { stdio: 'inherit' })
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => child.kill(sig))
child.on('exit', (code) => process.exit(code ?? 0))
