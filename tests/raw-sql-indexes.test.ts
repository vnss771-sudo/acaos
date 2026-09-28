import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// scripts/sql/raw-indexes/* re-create raw-SQL-only indexes at API startup
// (scripts/start-with-migrations.mjs). Each must stay idempotent and identical
// to the migration that introduced it, or a baselined database would end up with
// a different index than a migrated one.
const RAW_DIR = 'scripts/sql/raw-indexes'
const MIGRATIONS_DIR = 'packages/db/prisma/migrations'

const normalize = (sql: string) =>
  sql.replace(/--.*$/gm, '').replace(/\s+/g, ' ').replace(/ ?\( ?/g, '(').replace(/ \)/g, ')').trim()

const migrationSql = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => normalize(readFileSync(join(MIGRATIONS_DIR, d.name, 'migration.sql'), 'utf8')))
  .join(' ')

const files = readdirSync(RAW_DIR).filter((f) => f.endsWith('.sql'))

test('there is at least one raw-SQL index file', () => {
  assert.ok(files.length > 0)
})

for (const file of files) {
  const sql = normalize(readFileSync(join(RAW_DIR, file), 'utf8'))

  test(`${file}: is idempotent (IF NOT EXISTS)`, () => {
    assert.match(sql, /^CREATE UNIQUE INDEX IF NOT EXISTS "/)
  })

  test(`${file}: matches the migration that introduced it`, () => {
    // The same statement minus IF NOT EXISTS must appear in a migration.
    const asInMigration = sql.replace('IF NOT EXISTS ', '').replace(/;$/, '')
    assert.ok(migrationSql.includes(asInMigration), `no migration contains: ${asInMigration}`)
  })
}
