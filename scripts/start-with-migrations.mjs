#!/usr/bin/env node
/**
 * Safe production startup for the API.
 *
 * Replaces the dangerous `prisma db push --accept-data-loss` start command —
 * which can silently DROP columns/constraints on a schema change — with proper
 * versioned migrations:
 *
 *   1. `prisma migrate deploy` (applies only pending, reviewed migrations).
 *   2. One-time auto-baseline: if the database was originally created with
 *      `db push` (no migration history) Prisma raises P3005 on a non-empty DB.
 *      We then mark the existing migrations as already-applied — this writes ONLY
 *      to the `_prisma_migrations` ledger, never to table data — and retry.
 *   3. Start the server. If migrations cannot be applied, we EXIT NON-ZERO and do
 *      NOT start: a half-migrated API is worse than a failed deploy.
 *
 * Set the platform start command to:  node scripts/start-with-migrations.mjs
 */
import { execFileSync, spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'

const SCHEMA = 'packages/db/prisma/schema.prisma'
const SERVER = 'apps/api/dist/server.js'
const MIGRATIONS_DIR = 'packages/db/prisma/migrations'
const RAW_INDEX_DIR = 'scripts/sql/raw-indexes'

function prisma(args) {
  // Throws on non-zero exit; caller inspects err.stdout/err.stderr.
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
    .sort() // timestamp-prefixed names sort chronologically
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

// Raw-SQL-only indexes (partial uniques Prisma's schema can't express) — see
// scripts/sql/raw-indexes/README.md. A database ever run with `db push` lacks
// them, and baselining marks their migrations applied without running them, so
// re-create them idempotently on every start, one file at a time so one failure
// can't block the rest. Best-effort: existing duplicate rows make a unique index
// fail; that state predates this deploy, so warn loudly and start anyway.
for (const file of readdirSync(RAW_INDEX_DIR).filter((f) => f.endsWith('.sql')).sort()) {
  try {
    prisma(['db', 'execute', '--file', `${RAW_INDEX_DIR}/${file}`, '--schema', SCHEMA])
    console.log(`[startup] raw-SQL index ok: ${file}`)
  } catch (err) {
    console.warn(`[startup] WARNING: could not ensure raw-SQL index ${file} — likely duplicate rows; this guard is OFF until they are removed:\n${err.stdout || ''}${err.stderr || ''}`)
  }
}

if (process.env.MIGRATIONS_ONLY === '1') {
  console.log('[startup] MIGRATIONS_ONLY=1 — database ready, not starting the API.')
  process.exit(0)
}

console.log(`[startup] database up to date — starting API (${SERVER}).`)
const child = spawn('node', [SERVER], { stdio: 'inherit' })
// Propagate termination signals so the platform can stop the container cleanly.
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => child.kill(sig))
child.on('exit', (code) => process.exit(code ?? 0))
