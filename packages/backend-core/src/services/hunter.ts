// Hunter.io enrichment: given a company domain, find the best contact email
// (domain-search) and verify deliverability (email-verifier). Used as a
// post-discovery enrichment step when a prospect has no contactEmail.
//
// Lives in backend-core so both the API (via the apps/api/src/services/hunter.ts
// re-export shim) and the worker's batch enrichment can call it. All calls are
// best-effort and fail soft (return null) — enrichment must never hard-fail on a
// flaky third-party lookup.

import { hunterBreaker } from '../lib/circuit.js'
import { providerFetch } from '../lib/providerHttp.js'

type HunterContact = {
  email: string
  firstName?: string
  lastName?: string
  position?: string
  confidence: number
}

export type HunterVerification = {
  // Hunter's verdict: 'deliverable' | 'risky' | 'undeliverable' | 'unknown'
  result: string
  // Deliverability score 0–100
  score: number
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
    const res = await providerFetch(url.toString(), {}, { provider: 'hunter', envPrefix: 'HUNTER', breaker: hunterBreaker })
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

// Verify an email address before we treat it as sendable. Returns null when
// Hunter is not configured or the lookup fails — callers treat "no verification"
// as non-blocking (we still write the email), and only suppress the write on a
// definitive 'undeliverable' verdict.
export async function verifyEmail(email: string): Promise<HunterVerification | null> {
  if (!isHunterConfigured() || !email) return null

  const apiKey = process.env.HUNTER_API_KEY!
  const url = new URL('https://api.hunter.io/v2/email-verifier')
  url.searchParams.set('email', email)
  url.searchParams.set('api_key', apiKey)

  try {
    const res = await providerFetch(url.toString(), {}, { provider: 'hunter', envPrefix: 'HUNTER', breaker: hunterBreaker })
    if (!res.ok) return null

    const data = await res.json() as {
      data?: { result?: string; status?: string; score?: number }
    }
    const d = data.data
    if (!d) return null

    return {
      result: d.result ?? d.status ?? 'unknown',
      score:  typeof d.score === 'number' ? d.score : 0,
    }
  } catch {
    return null
  }
}
