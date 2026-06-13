/**
 * Prospect source abstraction — plug in Apollo, Hunter, Google Places, etc.
 * without touching the scoring engine, mission builder, or dashboard.
 */

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
}

export interface ProspectSourceProvider {
  readonly name: string
  readonly label: string
  readonly isConfigured: boolean
  search(input: ProspectSearchInput): Promise<ProspectCandidate[]>
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
  readonly isConfigured = Boolean(process.env.APOLLO_API_KEY)

  async search(input: ProspectSearchInput): Promise<ProspectCandidate[]> {
    if (!this.isConfigured) return []
    // TODO: implement Apollo people search using APOLLO_API_KEY
    // POST https://api.apollo.io/v1/mixed_companies/search
    void input
    return []
  }
}

class HunterSource implements ProspectSourceProvider {
  readonly name = 'hunter'
  readonly label = 'Hunter.io'
  readonly isConfigured = Boolean(process.env.HUNTER_API_KEY)

  async search(input: ProspectSearchInput): Promise<ProspectCandidate[]> {
    if (!this.isConfigured) return []
    // TODO: implement Hunter domain search using HUNTER_API_KEY
    void input
    return []
  }
}

// ── Registry ──────────────────────────────────────────────────────────────────

const SOURCES: ProspectSourceProvider[] = [
  new CsvImportSource(),
  new ApolloSource(),
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
