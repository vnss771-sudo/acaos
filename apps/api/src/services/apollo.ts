// Apollo.io enrichment service.
//
// Like the other external integrations (openai, stripe, mail) this is a
// configuration-guarded scaffold: it requires an APOLLO_API_KEY and surfaces a
// clean 503 when the integration is not configured, rather than letting the
// route fail with an unhandled error. Wire real Apollo API calls into
// `enrichProspect` when the integration is provisioned.

import { ApiError } from '../lib/http.js'
import { hasEnv } from '../lib/env.js'

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
  // New signals discovered for the prospect.
  signals: EnrichmentSignal[]
  // Field updates to merge onto the prospect (industry, employeeCount, …).
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

export function isApolloConfigured(): boolean {
  return hasEnv(['APOLLO_API_KEY'])
}

export async function enrichProspect(_prospect: EnrichableProspect): Promise<EnrichmentResult> {
  if (!isApolloConfigured()) {
    throw new ApiError(503, 'Apollo enrichment is not configured')
  }

  // Live Apollo API integration is not yet wired up. Returning an empty result
  // keeps the rescore pipeline well-defined for configured-but-unimplemented
  // environments without fabricating signals.
  return { signals: [], updates: {} }
}
