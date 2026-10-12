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
  let checked = 0
  let affected = 0
  let cursor
  const batchSize = 500
  for (;;) {
    const rows = await prisma.discoverySourceState.findMany({
      select: { id: true, lastError: true, lastWarning: true },
      orderBy: { id: 'asc' },
      take: batchSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })
    for (const row of rows) {
      if (RE.test(row.lastError ?? '') || RE.test(row.lastWarning ?? '')) affected++
    }
    checked += rows.length
    if (rows.length < batchSize) break
    cursor = rows[rows.length - 1].id
  }
  // No emails, key values, diagnostics, or workspace identifiers are printed.
  console.log(`checked ${checked} rows; ${affected} contain a credential-like query parameter`)
  if (affected) console.log('ACTION NEEDED: assess affected provider secrets before approved rotation and cleanup.')
  process.exitCode = affected ? 1 : 0
} finally {
  await prisma.$disconnect()
}
