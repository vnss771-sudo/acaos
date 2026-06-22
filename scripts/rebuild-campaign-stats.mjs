#!/usr/bin/env node
/**
 * Rebuild CampaignDailyStats from the ContactEvent ledger.
 *
 * CampaignDailyStats is a fast read-model that's live-incremented in the SENT/
 * REPLIED transactions. The ContactEvent ledger is the source of truth, so if the
 * projection ever drifts (a bug, a partial failure, a manual edit) this recomputes
 * the affected rows by re-aggregating the ledger. Idempotent — safe to re-run.
 *
 * Usage:
 *   node scripts/rebuild-campaign-stats.mjs --workspaceId=<id> [--from=2026-01-01]
 *
 * Requires a real (non-offline) Prisma client and a reachable DATABASE_URL.
 */
import { rebuildCampaignStats } from '../packages/backend-core/src/lib/campaignStats.js'

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : undefined
}

const workspaceId = arg('workspaceId')
const fromStr = arg('from')

if (!workspaceId) {
  console.error('Usage: node scripts/rebuild-campaign-stats.mjs --workspaceId=<id> [--from=YYYY-MM-DD]')
  process.exit(2)
}

const from = fromStr ? new Date(fromStr) : undefined
if (from && Number.isNaN(from.getTime())) {
  console.error(`Invalid --from date: ${fromStr}`)
  process.exit(2)
}

try {
  const { rows } = await rebuildCampaignStats(workspaceId, from)
  console.log(`[rebuild-campaign-stats] workspace=${workspaceId}${from ? ` from=${from.toISOString()}` : ''}: rebuilt ${rows} daily row(s)`)
  process.exit(0)
} catch (err) {
  console.error('[rebuild-campaign-stats] failed:', err)
  process.exit(1)
}
