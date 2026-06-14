/**
 * Prospect source abstraction — plug in Apollo, Hunter, Google Places, etc.
 * without touching the scoring engine, mission builder, or dashboard.
 */

import { apolloSearchBreaker } from './circuit.js'

export type ProspectSearchInput = {
  industries?: string[]
  locations?: string[]
  keywords?: string[]
  minEmployees?: number
  maxEmployees?: number
  limit?: number
}

export type ProspectCandidate = {
  companyName: string
  domain?: string
  industry?: string
  location?: string
  employeeCount?: number
  contactName?: string
  contactEmail?: string
  contactTitle?: string
  description?: string
  sourceId?: string   // deduplication key from the external source
  hiringCount?: number
  totalFunding?: number
  fundingStage?: string
}

export interface ProspectSourceProvider {
  readonly name: string
  readonly label: string
  readonly isConfigured: boolean
  search(input: ProspectSearchInput): Promise<ProspectCandidate[]>
}

// ── Apollo org shape (partial) ─────────────────────────────────────────────────

type ApolloOrg = {
  id?: string
  name?: string
  website_url?: string
  primary_domain?: string
  industry?: string
  estimated_num_employees?: number
  current_jobs_count?: number
  short_description?: string
  total_funding?: number
  latest_funding_stage?: string
  primary_address?: {
    city?: string
    state?: string
    country?: string
  }
}

function apolloOrgToCandidate(org: ApolloOrg): ProspectCandidate {
  const loc = org.primary_address
    ? [org.primary_address.city, org.primary_address.state, org.primary_address.country]
        .filter(Boolean).join(', ')
    : undefined
  return {
    companyName:   org.name ?? '',
    domain:        org.primary_domain ?? undefined,
    industry:      org.industry       ?? undefined,
    location:      loc                || undefined,
    employeeCount: org.estimated_num_employees ?? undefined,
    description:   org.short_description      ?? undefined,
    sourceId:      org.id                     ?? undefined,
    hiringCount:   org.current_jobs_count     ?? undefined,
    totalFunding:  org.total_funding          ?? undefined,
    fundingStage:  org.latest_funding_stage   ?? undefined,
  }
}

// ── Built-in sources ──────────────────────────────────────────────────────────

class CsvImportSource implements ProspectSourceProvider {
  readonly name = 'csv'
  readonly label = 'CSV Import'
  readonly isConfigured = true

  async search(_input: ProspectSearchInput): Promise<ProspectCandidate[]> {
    // CSV import is handled by the file-upload endpoint, not a search.
    return []
  }
}

class ApolloSource implements ProspectSourceProvider {
  readonly name = 'apollo'
  readonly label = 'Apollo.io'

  get isConfigured() { return Boolean(process.env.APOLLO_API_KEY) }

  async search(input: ProspectSearchInput): Promise<ProspectCandidate[]> {
    if (!this.isConfigured) return []

    const apiKey  = process.env.APOLLO_API_KEY!
    const perPage = Math.min(input.limit ?? 25, 50)

    const body: Record<string, unknown> = { page: 1, per_page: perPage }
    if (input.industries?.length)          body.q_organization_industries = input.industries
    if (input.locations?.length)           body.q_organization_locations  = input.locations
    if (input.keywords?.length)            body.q_keywords = input.keywords.join(' ')
    if (input.minEmployees || input.maxEmployees) {
      const min = input.minEmployees ?? 1
      const max = input.maxEmployees ?? 99999
      body.organization_num_employees_ranges = [`${min},${max}`]
    }

    return apolloSearchBreaker.call(async () => {
      const res = await fetch('https://api.apollo.io/v1/mixed_companies/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'Cache-Control': 'no-cache',
        },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const msg = await res.text().catch(() => res.statusText)
        throw new Error(`Apollo search ${res.status}: ${msg.slice(0, 200)}`)
      }

      const data = await res.json() as { organizations?: ApolloOrg[] }
      return (data.organizations ?? [])
        .filter(o => o.name)
        .map(apolloOrgToCandidate)
    })
  }
}

class HunterSource implements ProspectSourceProvider {
  readonly name = 'hunter'
  readonly label = 'Hunter.io'

  get isConfigured() { return Boolean(process.env.HUNTER_API_KEY) }

  async search(input: ProspectSearchInput): Promise<ProspectCandidate[]> {
    if (!this.isConfigured) return []
    // Hunter is domain-lookup, not company discovery — wire when needed.
    void input
    return []
  }
}

class GooglePlacesSource implements ProspectSourceProvider {
  readonly name = 'google_places'
  readonly label = 'Google Places'

  get isConfigured() { return Boolean(process.env.GOOGLE_PLACES_API_KEY) }

  async search(input: ProspectSearchInput): Promise<ProspectCandidate[]> {
    if (!this.isConfigured) return []

    const apiKey = process.env.GOOGLE_PLACES_API_KEY!
    const limit  = Math.min(input.limit ?? 20, 20)

    // Build a natural-language query: e.g. "electricians in Sydney Australia"
    const industry = input.industries?.[0] ?? input.keywords?.[0] ?? ''
    const location = input.locations?.[0]  ?? ''
    const textQuery = [industry, location].filter(Boolean).join(' in ')
    if (!textQuery) return []

    try {
      const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': [
            'places.id', 'places.displayName', 'places.formattedAddress',
            'places.websiteUri', 'places.businessStatus',
            'places.nationalPhoneNumber', 'places.types',
          ].join(','),
        },
        body: JSON.stringify({ textQuery, pageSize: limit }),
      })

      if (!res.ok) return []

      const data = await res.json() as {
        places?: Array<{
          id?: string
          displayName?: { text?: string }
          formattedAddress?: string
          websiteUri?: string
          nationalPhoneNumber?: string
          types?: string[]
          businessStatus?: string
        }>
      }

      return (data.places ?? [])
        .filter(p => p.businessStatus !== 'CLOSED_PERMANENTLY' && p.displayName?.text)
        .map(p => {
          let domain: string | undefined
          try { domain = new URL(p.websiteUri!).hostname.replace(/^www\./, '') } catch { /* no website */ }
          return {
            companyName: p.displayName!.text!,
            domain,
            location:    p.formattedAddress ?? undefined,
            description: p.types?.slice(0, 3).map(t => t.replace(/_/g, ' ')).join(', ') ?? undefined,
            sourceId:    p.id ?? undefined,
          }
        })
    } catch {
      return []
    }
  }
}

// ── Registry ──────────────────────────────────────────────────────────────────

const SOURCES: ProspectSourceProvider[] = [
  new CsvImportSource(),
  new ApolloSource(),
  new GooglePlacesSource(),
  new HunterSource(),
]

export function getConfiguredSources(): ProspectSourceProvider[] {
  return SOURCES.filter(s => s.isConfigured)
}

export function getSource(name: string): ProspectSourceProvider | undefined {
  return SOURCES.find(s => s.name === name)
}

export function listSources(): { name: string; label: string; isConfigured: boolean }[] {
  return SOURCES.map(s => ({ name: s.name, label: s.label, isConfigured: s.isConfigured }))
}
