#!/usr/bin/env node
// Test-tier isolation guard (review follow-up). The test suite is split into
// tiers — tests/ (pure unit, no external services), tests-db/ (Postgres),
// tests-redis/ (Redis, may also use Postgres for jobs/SSE). A Redis-only test
// once broke because it imported a helper that eagerly pulled the DB fixtures,
// so it failed with a DATABASE_URL error before the Redis preflight ran. This
// guard pins the tier boundaries so that class of cross-tier coupling can't
// regress:
//   1. tests/ (unit tier) must not import from tests-db/ or tests-redis/ — unit
//      tests have to run with no services.
//   2. the Redis-ONLY helpers (tests-redis/helpers/{redis,requireRedis}.ts) must
//      not import from tests-db/ — they exist precisely to stay DB-free.
// (tests-redis/helpers/env.ts importing tests-db is INTENTIONAL — the jobs/SSE
// integration tests need both tiers — and is allowed.)
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')

function walk(dir) {
  const out = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

// Match real import/re-export specifiers (static or dynamic), not comments.
function importsMatching(src, re) {
  const specifier = /(?:import|export)[^'"\n]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  const hits = []
  let m
  while ((m = specifier.exec(src))) {
    const spec = m[1] ?? m[2]
    if (spec && re.test(spec)) hits.push(spec)
  }
  return hits
}

const errors = []

// Rule 1: unit tier (tests/) must not reach into the service tiers.
for (const file of walk(join(ROOT, 'tests'))) {
  const hits = importsMatching(readFileSync(file, 'utf8'), /tests-(db|redis)\//)
  for (const h of hits) {
    errors.push(`${relative(ROOT, file)} imports "${h}" — the unit tier (tests/) must not depend on tests-db/ or tests-redis/.`)
  }
}

// Rule 2: the Redis-only helpers must stay free of the DB fixtures.
for (const rel of ['tests-redis/helpers/redis.ts', 'tests-redis/helpers/requireRedis.ts']) {
  const full = join(ROOT, rel)
  if (!existsSync(full)) continue
  const hits = importsMatching(readFileSync(full, 'utf8'), /tests-db\//)
  for (const h of hits) {
    errors.push(`${rel} imports "${h}" — the Redis-only helpers must not pull in the DB tier (use tests-redis/helpers/env.ts for combined tiers).`)
  }
}

if (errors.length) {
  console.error('✗ Test-tier isolation violated:')
  for (const e of errors) console.error(`    ${e}`)
  console.error('  See scripts/check-test-tiers.mjs.')
  process.exit(1)
}
console.log('✓ Test tiers are isolated (unit tier service-free; Redis-only helpers DB-free).')
