// Google News search via Serper API — skips gracefully when SERPER_API_KEY is absent.
// Returns up to `limit` article titles + URLs published within the last `withinDays` days.

import { cfg } from '../lib/env.js'

export type NewsArticle = {
  title: string
  url:   string
  date:  Date | null
}

const API_URL = 'https://google.serper.dev/news'

export async function fetchNewsForCompany(
  companyName: string,
  domain?:     string | null,
  opts:        { limit?: number; withinDays?: number } = {}
): Promise<NewsArticle[]> {
  if (!cfg.serperApiKey) return []

  const { limit = 5, withinDays = 30 } = opts
  const query = domain ? `"${companyName}" OR site:${domain}` : `"${companyName}"`

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': cfg.serperApiKey,
      },
      body: JSON.stringify({ q: query, num: limit, tbs: `qdr:m${Math.ceil(withinDays / 30)}` }),
      signal: AbortSignal.timeout(8_000),
    })

    if (!res.ok) return []

    const json = await res.json() as { news?: Array<{ title: string; link: string; date?: string }> }
    const cutoff = new Date(Date.now() - withinDays * 86_400_000)

    return (json.news ?? [])
      .map(a => {
        const date = a.date ? new Date(a.date) : null
        return { title: a.title, url: a.link, date }
      })
      .filter(a => !a.date || a.date >= cutoff)
      .slice(0, limit)
  } catch {
    return []
  }
}
