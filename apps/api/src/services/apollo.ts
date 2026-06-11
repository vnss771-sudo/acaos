import type { SignalType } from '../lib/signalEngine.js'
import { cfg } from '../lib/env.js'

type ProspectInput = {
  id: string
  workspaceId: string
  companyName: string
  domain?: string | null
  industry?: string | null
  employeeCount?: number | null
  contactName?: string | null
  contactEmail?: string | null
  contactPhone?: string | null
  contactTitle?: string | null
  linkedinUrl?: string | null
  location?: string | null
  description?: string | null
}

type EnrichSignal = {
  type: SignalType
  strength: number
  sourceReliability: number
  industryRelevance: number
  title: string
  description: string
  source: string
  detectedAt: Date
}

type SafeUpdates = {
  industry?: string
  employeeCount?: number
  contactEmail?: string
  contactName?: string
  contactPhone?: string
  contactTitle?: string
  linkedinUrl?: string
  domain?: string
  description?: string
  location?: string
}

export type EnrichResult = {
  signals: EnrichSignal[]
  updates: SafeUpdates
}

const APOLLO_BASE = 'https://api.apollo.io/v1'

async function apolloPost(path: string, body: unknown): Promise<unknown> {
  const apiKey = cfg.apolloApiKey
  if (!apiKey) throw new Error('APOLLO_API_KEY not configured')


  const res = await fetch(`${APOLLO_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      'X-Api-Key': apiKey,
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Apollo API ${res.status}: ${text.slice(0, 200)}`)
  }
  return res.json()
}

function deriveSignals(org: Record<string, unknown>): EnrichSignal[] {
  const signals: EnrichSignal[] = []
  const now = new Date()

  const jobPostings = (org.job_postings_count as number | undefined) ?? 0
  if (jobPostings > 5) {
    signals.push({
      type: 'HIRING',
      strength: Math.min(100, 40 + jobPostings * 2),
      sourceReliability: 85,
      industryRelevance: 70,
      title: `Active hiring: ${jobPostings} open positions`,
      description: `Apollo reports ${jobPostings} active job postings indicating team growth`,
      source: 'apollo',
      detectedAt: now,
    })
  }

  const funding = org.latest_funding_stage as string | undefined
  if (funding && funding !== 'unknown' && funding !== '') {
    signals.push({
      type: 'FUNDING',
      strength: 75,
      sourceReliability: 80,
      industryRelevance: 75,
      title: `Funding stage: ${funding}`,
      description: `Company has reached ${funding} funding stage`,
      source: 'apollo',
      detectedAt: now,
    })
  }

  const technologies = (org.currently_using_any_of as string[] | undefined) ?? []
  if (technologies.length > 0) {
    signals.push({
      type: 'TECH_ADOPTION',
      strength: 60,
      sourceReliability: 75,
      industryRelevance: 65,
      title: `Technology stack: ${technologies.slice(0, 3).join(', ')}`,
      description: `Company uses ${technologies.length} tracked technologies`,
      source: 'apollo',
      detectedAt: now,
    })
  }

  return signals
}

function extractSafeUpdates(org: Record<string, unknown>, person: Record<string, unknown> | null): SafeUpdates {
  const updates: SafeUpdates = {}

  if (typeof org.industry === 'string' && org.industry) updates.industry = org.industry
  if (typeof org.estimated_num_employees === 'number') updates.employeeCount = org.estimated_num_employees
  if (typeof org.website_url === 'string' && org.website_url) {
    try {
      const host = new URL(org.website_url).hostname.replace(/^www\./, '')
      if (host) updates.domain = host
    } catch { /* malformed URL — skip */ }
  }
  if (typeof org.short_description === 'string' && org.short_description) updates.description = org.short_description
  if (typeof org.city === 'string' && org.city) {
    const parts = [org.city as string]
    if (typeof org.country === 'string' && org.country) parts.push(org.country as string)
    updates.location = parts.join(', ')
  }

  if (person) {
    if (typeof person.email === 'string' && person.email) updates.contactEmail = person.email
    if (typeof person.name === 'string' && person.name) updates.contactName = person.name
    if (typeof person.title === 'string' && person.title) updates.contactTitle = person.title
    if (typeof person.linkedin_url === 'string' && person.linkedin_url) updates.linkedinUrl = person.linkedin_url
  }

  return updates
}

export async function fetchJobPostings(domain: string): Promise<Array<{ title: string; postedAt: Date | null }>> {
  if (!cfg.apolloApiKey) return []
  try {
    const result = await apolloPost('/organizations/enrich', { domain }) as {
      organization?: { job_postings?: Array<{ title?: string; posted_at?: string }> }
    }
    const postings = result?.organization?.job_postings ?? []
    return postings
      .filter((p): p is { title: string; posted_at?: string } => typeof p.title === 'string' && p.title.length > 0)
      .map(p => ({ title: p.title, postedAt: p.posted_at ? new Date(p.posted_at) : null }))
  } catch {
    return []
  }
}

export async function enrichProspect(prospect: ProspectInput): Promise<EnrichResult> {
  if (!cfg.apolloApiKey) {
    return { signals: [], updates: {} }
  }

  let org: Record<string, unknown> = {}
  let person: Record<string, unknown> | null = null

  try {
    const orgResult = await apolloPost('/organizations/enrich', {
      domain: prospect.domain ?? prospect.companyName,
    }) as { organization?: Record<string, unknown> }
    org = orgResult?.organization ?? {}
  } catch (err) {
    console.warn('[apollo] org enrich failed:', (err as Error).message)
  }

  if (prospect.contactEmail || (prospect.contactName && prospect.domain)) {
    try {
      const personResult = await apolloPost('/people/match', {
        email: prospect.contactEmail,
        first_name: prospect.contactName?.split(' ')[0],
        last_name: prospect.contactName?.split(' ').slice(1).join(' '),
        organization_domain: prospect.domain,
      }) as { person?: Record<string, unknown> }
      person = personResult?.person ?? null
    } catch (err) {
      console.warn('[apollo] people match failed:', (err as Error).message)
    }
  }

  return {
    signals: deriveSignals(org),
    updates: extractSafeUpdates(org, person),
  }
}
