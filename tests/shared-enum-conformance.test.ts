// A+ guard: the canonical domain enums in @acaos/shared were intentionally
// decoupled from Prisma's generated enum exports (so app code doesn't depend on
// the generated client's brittle enum surface). That decoupling is only safe if
// the two CANNOT silently drift — a value added to the DB schema but not to
// @acaos/shared (or vice-versa) would compile fine and fail at runtime.
//
// This meta-test parses both sources of truth and asserts they agree, so any
// future schema change must update @acaos/shared (and this list) in lockstep.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const schemaSrc = readFileSync(fileURLToPath(new URL('packages/db/prisma/schema.prisma', root)), 'utf8')
const sharedSrc = readFileSync(fileURLToPath(new URL('packages/shared/src/index.ts', root)), 'utf8')

/** Values of a `enum Name { A\n B }` block in the Prisma schema. */
function prismaEnum(name: string): string[] | null {
  const m = schemaSrc.match(new RegExp(`enum ${name}\\s*\\{([^}]*)\\}`))
  if (!m) return null
  return m[1].split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('//'))
}

/** String-literal members of an `export type Name = 'a' | 'b' | …` union. */
function sharedUnion(name: string): string[] | null {
  const m = sharedSrc.match(new RegExp(`export type ${name}\\s*=([\\s\\S]*?)(?=\\nexport |$)`))
  if (!m) return null
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
}

// Every Prisma enum that has a canonical @acaos/shared mirror. WorkspaceRole is
// deliberately absent — Membership.role is a String column, not a DB enum, so it
// is app-level only and asserted separately below.
const MIRRORED = [
  'SignalType',
  'BuyingStage',
  'OutcomeStage',
  'DraftStatus',
  'MissionStatus',
  'DiscoveryRunStatus',
  'SendStatus',
  'BillingPlan',
  'LeadStage',
  'OutreachIntentStatus',
] as const

for (const name of MIRRORED) {
  test(`@acaos/shared ${name} exactly matches the Prisma enum`, () => {
    const fromPrisma = prismaEnum(name)
    const fromShared = sharedUnion(name)
    assert.ok(fromPrisma, `Prisma enum ${name} not found in schema.prisma`)
    assert.ok(fromShared, `@acaos/shared type ${name} not found in index.ts`)
    assert.deepEqual(
      new Set(fromShared),
      new Set(fromPrisma),
      `${name} drift — schema: [${fromPrisma!.sort()}] vs shared: [${fromShared!.sort()}]`,
    )
  })
}

test('every Prisma schema enum has a canonical @acaos/shared mirror (no orphan DB enums)', () => {
  const declared = [...schemaSrc.matchAll(/^enum (\w+)\s*\{/gm)].map((m) => m[1])
  for (const name of declared) {
    assert.ok(
      (MIRRORED as readonly string[]).includes(name),
      `Prisma enum ${name} has no @acaos/shared mirror — add it to packages/shared and to MIRRORED here.`,
    )
  }
})

test('WorkspaceRole is app-level (String column) and not a Prisma enum', () => {
  assert.equal(prismaEnum('WorkspaceRole'), null, 'WorkspaceRole should NOT be a DB enum')
  assert.deepEqual(new Set(sharedUnion('WorkspaceRole')), new Set(['owner', 'admin', 'member']))
})
