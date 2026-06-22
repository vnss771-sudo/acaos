// Discovery unit economics.
//
// Prospect-discovery providers (Apollo, Google Places, Hunter) bill the
// *platform* through shared API keys, so the only way discovery's cost is
// legible per workspace is to weight each run by its provider. A flat run
// count hides that an Apollo company search costs the platform more than a
// Google Places text search. This module turns run counts into an estimated
// dollar cost so unit economics — not just call volume — are observable.
//
// These are deliberately rough, tunable estimates (USD cents per run), not
// invoices. They feed reporting/observability only; the enforced monthly
// discovery quota is a separate, plan-priced concept and is unaffected.
//
// All per-provider defaults are env-overridable so operators can track their
// actual pricing without a code change:
//   DISCOVERY_COST_APOLLO_CENTS        (default: 5)
//   DISCOVERY_COST_GOOGLE_PLACES_CENTS (default: 3)
//   DISCOVERY_COST_HUNTER_CENTS        (default: 2)

function envCents(envVar: string, dflt: number): number {
  const raw = process.env[envVar]
  if (!raw) return dflt
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : dflt
}

// Base defaults (code-level). Read from env at call-time so a running process
// picks up updates without a restart (e.g. via an env-update + reload).
function providerCostCents(): Record<string, number> {
  return {
    apollo: envCents('DISCOVERY_COST_APOLLO_CENTS', 5),         // Apollo credits are the priciest per company search
    google_places: envCents('DISCOVERY_COST_GOOGLE_PLACES_CENTS', 3),  // Places Text Search ≈ $32 / 1k requests
    hunter: envCents('DISCOVERY_COST_HUNTER_CENTS', 2),         // domain lookup
  }
}

// Sources with no external per-call cost (the built-in example source, manual
// imports, or any provider not yet priced) are treated as free.
export const DEFAULT_DISCOVERY_COST_CENTS = 0

export function discoveryProviderCostCents(source: string): number {
  return providerCostCents()[source] ?? DEFAULT_DISCOVERY_COST_CENTS
}

export type DiscoveryRunsBySource = Array<{ source: string; count: number }>

export type DiscoveryCostBreakdown = {
  totalCents: number
  byProvider: Record<string, { runs: number; costCents: number }>
}

// Pure: turn per-source run counts into a weighted cost breakdown. Source rows
// are merged defensively so callers can pass unaggregated data safely.
export function estimateDiscoveryCost(runs: DiscoveryRunsBySource): DiscoveryCostBreakdown {
  const byProvider: Record<string, { runs: number; costCents: number }> = {}
  let totalCents = 0
  for (const { source, count } of runs) {
    if (!Number.isFinite(count) || count <= 0) continue
    const costCents = discoveryProviderCostCents(source) * count
    const prev = byProvider[source] ?? { runs: 0, costCents: 0 }
    byProvider[source] = { runs: prev.runs + count, costCents: prev.costCents + costCents }
    totalCents += costCents
  }
  return { totalCents, byProvider }
}
