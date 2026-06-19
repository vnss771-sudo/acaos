// Apollo.io enrichment service.
// Enriches a prospect by domain/name → extracts HIRING, FUNDING, EXPANSION signals.
//
// Lives in backend-core so both the API (via the apps/api/src/services/apollo.ts
// re-export shim) and the worker's batch enrichment can call it without the worker
// depending on apps/api.

import { ApiError } from '../lib/errors.js'
import { hasEnv } from '../lib/env.js'
import { apolloBreaker } from '../lib/circuit.js'
import { providerFetch } from '../lib/providerHttp.js'

export type EnrichmentSignal = {
  type: string
  strength: number
  sourceReliability: number
  industryRelevance: number
  title: string | null
  description: string | null
  source: string
  detectedAt: Date
}

export type EnrichmentResult = {
  signals: EnrichmentSignal[]
  updates: Record<string, unknown>
}

export type EnrichableProspect = {
  id: string
  companyName: string
  domain: string | null
  industry: string | null
  employeeCount: number | null
  contactEmail: string | null
  contactName: string | null
}

type ApolloOrg = {
  name?: string
  industry?: string
  estimated_num_employees?: number
  current_jobs_count?: number
  total_funding?: number
  total_funding_printed?: string
  latest_funding_stage?: string
  latest_funding_round_date?: string
  linkedin_url?: string
  phone?: string
  primary_domain?: string
  short_description?: string
  primary_address?: { city?: string; state?: string; country?: string }
}

export function isApolloConfigured(): boolean {
  return hasEnv(['APOLLO_API_KEY'])
}

export async function enrichProspect(prospect: EnrichableProspect): Promise<EnrichmentResult> {
  if (!isApolloConfigured()) {
    throw new ApiError(503, 'Apollo enrichment is not configured')
  }

  return apolloBreaker.call(async () => {
    const apiKey = process.env.APOLLO_API_KEY!

    const body: Record<string, unknown> = prospect.domain
      ? { domain: prospect.domain }
      : { name: prospect.companyName }

    // Breaker is applied by the surrounding apolloBreaker.call; providerFetch
    // adds the timeout / transient-retry / size-bound that raw fetch lacked.
    const res = await providerFetch('https://api.apollo.io/v1/organizations/enrich', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'Cache-Control': 'no-cache',
      },
      body: JSON.stringify(body),
    }, { provider: 'apollo-enrich' })

    if (!res.ok) return { signals: [], updates: {} }

    const data = await res.json() as { organization?: ApolloOrg }
    const org = data.organization
    if (!org) return { signals: [], updates: {} }

    const signals: EnrichmentSignal[] = []
    const updates: Record<string, unknown> = {}
    const now = new Date()

    // Field updates: backfill empty fields from Apollo data
    if (org.estimated_num_employees && !prospect.employeeCount) {
      updates.employeeCount = org.estimated_num_employees
    }
    if (org.industry && !prospect.industry) {
      updates.industry = org.industry
    }

    // HIRING signal from open job listings
    const jobs = org.current_jobs_count ?? 0
    if (jobs > 0) {
      signals.push({
        type: 'HIRING',
        // Strength scales with posting count: 3 open roles ≈ 60, 10+ ≈ 90
        strength: Math.min(95, 50 + jobs * 4),
        sourceReliability: 80,
        industryRelevance: 75,
        title: `${jobs} open position${jobs !== 1 ? 's' : ''} on Apollo`,
        description: null,
        source: 'apollo',
        detectedAt: now,
      })
    }

    // FUNDING signal from funding data
    if (org.latest_funding_stage && org.total_funding && org.total_funding > 0) {
      const amount = org.total_funding_printed
        ?? `$${(org.total_funding / 1_000_000).toFixed(1)}M`
      signals.push({
        type: 'FUNDING',
        strength: 85,
        sourceReliability: 90,
        industryRelevance: 80,
        title: `${org.latest_funding_stage} · ${amount} total funding`,
        description: org.latest_funding_round_date
          ? `Last round: ${org.latest_funding_round_date.slice(0, 10)}`
          : null,
        source: 'apollo',
        detectedAt: now,
      })
    }

    // EXPANSION signal when employee count grew since we last checked
    if (org.estimated_num_employees && prospect.employeeCount
        && org.estimated_num_employees > prospect.employeeCount * 1.15) {
      signals.push({
        type: 'EXPANSION',
        strength: 75,
        sourceReliability: 75,
        industryRelevance: 70,
        title: `Team size: ${prospect.employeeCount} → ${org.estimated_num_employees}`,
        description: null,
        source: 'apollo',
        detectedAt: now,
      })
      updates.employeeCount = org.estimated_num_employees
    }

    return { signals, updates }
  })
}
