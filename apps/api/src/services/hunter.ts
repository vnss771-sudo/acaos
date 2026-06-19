// Hunter.io domain-search: given a company domain, find the best contact email.
// Used as a post-discovery enrichment step when a prospect has no contactEmail.

import { callProvider, ProviderError } from '../lib/providerClient.js'
import { hunterBreaker } from '../lib/circuit.js'

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
    return await callProvider<HunterContact | null>({
      provider: 'hunter',
      operation: 'domain-search',
      url: url.toString(),
      breaker: hunterBreaker,
      // A 4xx (bad/unknown domain) is "no contact", not a fault.
      onClientError: () => null,
      onSuccess: async (res) => {
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
      },
    })
  } catch (err) {
    // A transient provider fault (timeout/429/5xx) has already been counted in
    // provider_calls_total and against the circuit breaker by callProvider — so
    // it is now *visible* to operators. We still return null to preserve this
    // function's "best-effort enrichment" contract for its callers.
    if (err instanceof ProviderError) return null
    throw err
  }
}
