#!/usr/bin/env node
/**
 * Live smoke check for the work-discovery sources (lib/opportunitySources.ts).
 * The connectors are coded against each provider's published format and unit
 * tested against fixtures; this script is what proves they still match the real
 * APIs. Run it before enabling OPPORTUNITY_DISCOVERY_ENABLED, and whenever a
 * source starts failing.
 *
 * For each source it: fetches one real window, validates the payload (a shape
 * change fails loudly), prints a few normalized items, runs them through the
 * matcher for a sample profile, and — for AusTender — checks the evidence link
 * it builds actually resolves.
 *
 * Usage (from the repo root):
 *   NODE_OPTIONS=--conditions=acaos-src npx tsx scripts/smoke-discovery-sources.mjs
 *   ... --source=austender           only one source
 *   ... --lat=-27.47 --lng=153.02    sample base (default: Brisbane)
 *   ... --trades=electrical,hvac     sample trades (default: electrical)
 *
 * PlanningAlerts is skipped unless PLANNINGALERTS_API_KEY is set.
 * Exit code: 0 all checked sources OK, 1 any source failed.
 */
import { OPPORTUNITY_SOURCES } from '@acaos/backend-core/lib/opportunitySources.js'
import { matchOpportunity, isRejection } from '@acaos/backend-core/lib/opportunityMatch.js'

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

const profile = {
  trades: arg('trades', 'electrical').split(',').filter(Boolean),
  keywords: [],
  baseLat: Number(arg('lat', '-27.4698')),
  baseLng: Number(arg('lng', '153.0251')),
  radiusKm: Number(arg('radius', '50')),
  regions: arg('regions', 'QLD').split(',').filter(Boolean),
  minValue: null,
}
const only = arg('source', null)
const now = new Date()
// Read a recent window rather than the connector's first-run lookback.
const cursors = {
  austender: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 3 * 86_400_000).toISOString(),
  planningalerts: null,
}

let failed = false
for (const source of OPPORTUNITY_SOURCES) {
  if (only && source.name !== only) continue
  console.log(`\n── ${source.label} (${source.name})`)
  if (!source.isConfigured) { console.log('   skipped: not configured (API key missing)'); continue }
  const unavailable = source.unavailableReason(profile)
  if (unavailable) { console.log(`   skipped: ${unavailable}`); continue }
  try {
    const started = Date.now()
    const r = await source.fetch({ cursor: cursors[source.name] ?? null, profile, now })
    console.log(`   fetched ${r.items.length} item(s) in ${Date.now() - started} ms; next cursor ${r.nextCursor}`)
    if (r.warning) console.log(`   warning: ${r.warning}`)
    if (r.items.length === 0) console.log('   note: no items in this window — widen it or try another day before concluding the source is broken')

    const matched = r.items.map((c) => ({ c, m: matchOpportunity(c, profile, now) })).filter((x) => !isRejection(x.m))
    console.log(`   ${matched.length} match the sample profile (${profile.trades.join(', ')} within ${profile.radiusKm} km / ${profile.regions.join(', ')})`)
    for (const { c, m } of matched.slice(0, 3)) {
      console.log(`   • [${m.score}] ${c.title}`)
      for (const reason of m.reasons) console.log(`       - ${reason}`)
    }
    for (const c of r.items.slice(0, 2)) console.log(`   sample: ${JSON.stringify({ ...c, raw: undefined }).slice(0, 400)}`)

    const withUrl = r.items.find((c) => c.sourceUrl)
    if (source.name === 'austender' && withUrl) {
      const res = await fetch(withUrl.sourceUrl, { headers: { Accept: 'application/json' } })
      console.log(`   evidence link ${withUrl.sourceUrl} → HTTP ${res.status}${res.ok ? '' : '  ← the link format needs fixing'}`)
      if (!res.ok) failed = true
    }
  } catch (err) {
    failed = true
    console.log(`   FAILED: ${err instanceof Error ? err.message : err}`)
  }
}
process.exit(failed ? 1 : 0)
