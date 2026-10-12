#!/usr/bin/env node
/**
 * Read-only check for credentials persisted in
 * diagnostic fields (DiscoverySourceState.lastError / lastWarning). Counts rows
 * whose text contains a credential-bearing query parameter (key=, token=, ...).
 * It NEVER prints the matched text and writes nothing. Run it yourself against the
 * environment you want to inspect (uses DATABASE_URL); rotating a key and scrubbing
 * rows are separate, deliberate steps.
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient({ log: ['error'] })
const RE = /[?&;](api[_-]?key|key|token|secret|access[_-]?token|auth|password|sig|signature|guid)=[^&\s"'<>)]+/i

try {
  const rows = await prisma.discoverySourceState.findMany({
    select: { workspaceId: true, source: true, lastError: true, lastWarning: true },
  })
  const hits = rows.filter((r) => RE.test(r.lastError ?? '') || RE.test(r.lastWarning ?? ''))
  console.log(`checked ${rows.length} rows; ${hits.length} contain a credential-like query parameter`)
  for (const h of hits) console.log(`  workspace=${h.workspaceId} source=${h.source}`)
  if (hits.length) console.log('ACTION NEEDED: rotate the affected provider key and scrub these rows (with explicit approval).')
  process.exitCode = hits.length ? 1 : 0
} finally {
  await prisma.$disconnect()
}
