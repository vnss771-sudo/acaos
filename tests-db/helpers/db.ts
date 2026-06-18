// Helpers for the database-backed test tier.
//
// Unlike tests/ (which injects a fake Prisma client), these tests run the REAL
// Prisma client against a live PostgreSQL instance reachable via DATABASE_URL.
// That exercises actual query shapes, unique constraints, transactions, and
// cascade deletes that the fake cannot model.
//
// Provisioning is external: a migrated Postgres must be running and DATABASE_URL
// set before these tests run (see scripts/test-db-local.sh for local use, and
// the `verify-db` CI job for CI). The server/auth helpers are reused from the
// fake-Prisma harness — they do not touch the database layer.

import { prisma } from '../../packages/backend-core/src/lib/prisma.ts'

export { prisma }
export { startTestServer, bearer, type TestServer } from '../../tests/helpers/integration.ts'

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is required for the database-backed test tier. ' +
      'Run via `npm run test:db:local`, or set DATABASE_URL to a migrated Postgres.'
  )
}

/**
 * Truncate every application table (keeping the schema and migration history)
 * so each test starts from a clean slate. RESTART IDENTITY + CASCADE clears
 * dependents in one statement.
 */
export async function resetDb(): Promise<void> {
  const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `
  if (tables.length === 0) return
  const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ')
  await prisma.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`)
}

export async function disconnect(): Promise<void> {
  await prisma.$disconnect()
}

// --- Seed helpers -----------------------------------------------------------

export async function seedUser(email = 'owner@acme.test', name: string | null = null) {
  return prisma.user.create({ data: { email, name } })
}

/**
 * Create a workspace and attach `userId` as a member with the given role.
 * Returns the workspace.
 */
export async function seedWorkspace(
  userId: string,
  opts: { name?: string; slug?: string; role?: string; plan?: string; subscriptionStatus?: string | null } = {}
) {
  const slug = opts.slug ?? `ws-${Math.random().toString(36).slice(2, 10)}`
  return prisma.workspace.create({
    data: {
      name: opts.name ?? 'Acme',
      slug,
      plan: opts.plan ?? 'free',
      subscriptionStatus: opts.subscriptionStatus ?? null,
      memberships: { create: { userId, role: opts.role ?? 'owner' } },
    },
  })
}

/** Create a user that owns a fresh workspace; returns both. */
export async function seedUserWithWorkspace(email?: string, role = 'owner') {
  const user = await seedUser(email ?? `user-${Math.random().toString(36).slice(2, 8)}@acme.test`)
  const workspace = await seedWorkspace(user.id, { role })
  return { user, workspace }
}
