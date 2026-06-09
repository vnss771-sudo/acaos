// Apollo.io enrichment service
// Reads APOLLO_API_KEY from environment. If not set, returns empty enrichment.

const APOLLO_BASE = 'https://api.apollo.io/v1'

type ProspectInput = {
  id: string
  companyName: string
  domain?: string | null
  contactName?: string | null
  contactEmail?: string | null
  industry?: string | null
  employeeCount?: number | null
}

type SignalCreate = {
  type: string
  strength: number
  sourceReliability: number
  industryRelevance: number
  title: string
  description: string
  source: string
  detectedAt: Date
}

type EnrichResult = {
  signals: SignalCreate[]
  updates: Record<string, unknown>
}

async function apolloPost(path: string, body: Record<string, unknown>): Promise<unknown> {
  const apiKey = process.env.APOLLO_API_KEY
  if (!apiKey) return null

  const res = await fetch(`${APOLLO_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
    body: JSON.stringify(body)
  })
  if (!res.ok) return null
  return res.json()
}

export async function enrichProspect(prospect: ProspectInput): Promise<EnrichResult> {
  const signals: SignalCreate[] = []
  const updates: Record<string, unknown> = {}
  const now = new Date()

  if (!process.env.APOLLO_API_KEY) {
    return { signals, updates }
  }

  // Organisation enrichment
  const orgPayload: Record<string, unknown> = {}
  if (prospect.domain) orgPayload.domain = prospect.domain
  else orgPayload.name = prospect.companyName

  const orgData = await apolloPost('/organizations/enrich', orgPayload) as Record<string, unknown> | null
  const org = orgData?.organization as Record<string, unknown> | undefined

  if (org) {
    // Map enriched fields back to prospect updates
    if (org.industry && !prospect.industry) updates.industry = org.industry
    if (org.estimated_num_employees && !prospect.employeeCount) {
      updates.employeeCount = Number(org.estimated_num_employees)
    }
    if (org.website_url && !prospect.domain) {
      const domain = String(org.website_url).replace(/^https?:\/\//, '').split('/')[0]
      updates.domain = domain
    }
    if (org.short_description && !prospect.industry) {
      updates.description = org.short_description
    }

    // Job postings → HIRING signal
    const jobPostings = (org.job_postings as unknown[])?.length ?? 0
    if (jobPostings > 0) {
      signals.push({
        type: 'HIRING',
        strength: Math.min(95, 40 + jobPostings * 5),
        sourceReliability: 85,
        industryRelevance: 70,
        title: `${jobPostings} active job posting${jobPostings > 1 ? 's' : ''}`,
        description: `Apollo detected ${jobPostings} open roles — signals team expansion`,
        source: 'apollo',
        detectedAt: now
      })
    }

    // Recent funding → FUNDING signal
    const funding = org.latest_funding_round_date
      ? new Date(org.latest_funding_round_date as string)
      : null
    if (funding && (Date.now() - funding.getTime()) / 86_400_000 < 180) {
      const amount = org.latest_funding_round_amount
      signals.push({
        type: 'FUNDING',
        strength: 90,
        sourceReliability: 90,
        industryRelevance: 80,
        title: `Recent funding: ${amount ? `$${Number(amount).toLocaleString()}` : 'undisclosed'}`,
        description: `Funding detected via Apollo — signals spending capacity and growth intent`,
        source: 'apollo',
        detectedAt: funding
      })
    }

    // Technology stack changes → TECH_ADOPTION
    const techStack = (org.current_technologies as unknown[])?.length ?? 0
    if (techStack > 3) {
      signals.push({
        type: 'TECH_ADOPTION',
        strength: 55,
        sourceReliability: 75,
        industryRelevance: 60,
        title: `${techStack} technologies detected in tech stack`,
        description: `Active technology usage signals operational maturity and adoption appetite`,
        source: 'apollo',
        detectedAt: now
      })
    }
  }

  // People search — look for decision maker if no contact yet
  if (!prospect.contactEmail && prospect.domain) {
    const peopleData = await apolloPost('/mixed_people/search', {
      q_organization_domains: [prospect.domain],
      person_titles: ['CEO', 'CTO', 'Director', 'VP', 'Head of', 'Manager', 'Owner', 'Founder'],
      page: 1,
      per_page: 1
    }) as Record<string, unknown> | null

    const people = (peopleData?.people as Record<string, unknown>[]) ?? []
    const person = people[0]
    if (person) {
      if (person.name && !prospect.contactName) updates.contactName = person.name
      if (person.title) updates.contactTitle = person.title
      if (person.email) updates.contactEmail = person.email
      if (person.linkedin_url) updates.linkedinUrl = person.linkedin_url
    }
  }

  return { signals, updates }
}
