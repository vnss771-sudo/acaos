// Hunter.io domain-search: given a company domain, find the best contact email.
// Used as a post-discovery enrichment step when a prospect has no contactEmail.

import { fetchWithTimeout } from '../lib/fetchWithTimeout.js'

type HunterContact = {
  email: string
  firstName?: string
  lastName?: string
  position?: string
  confidence: number
}

export function isHunterConfigured(): boolean {
  return Boolean(process.env.HUNTER_API_KEY)
}

export async function findContactEmail(domain: string): Promise<HunterContact | null> {
  if (!isHunterConfigured()) return null

  const apiKey = process.env.HUNTER_API_KEY!
  const url = new URL('https://api.hunter.io/v2/domain-search')
  url.searchParams.set('domain', domain)
  url.searchParams.set('api_key', apiKey)
  url.searchParams.set('limit', '5')
  url.searchParams.set('type', 'personal')

  try {
    const res = await fetchWithTimeout(url.toString())
    if (!res.ok) return null

    const data = await res.json() as {
      data?: {
        emails?: Array<{
          value?: string
          first_name?: string
          last_name?: string
          position?: string
          confidence?: number
        }>
      }
    }

    const emails = (data.data?.emails ?? [])
      .filter(e => e.value && (e.confidence ?? 0) >= 50)
      .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))

    const best = emails[0]
    if (!best?.value) return null

    return {
      email:      best.value,
      firstName:  best.first_name ?? undefined,
      lastName:   best.last_name  ?? undefined,
      position:   best.position   ?? undefined,
      confidence: best.confidence ?? 0,
    }
  } catch {
    return null
  }
}
