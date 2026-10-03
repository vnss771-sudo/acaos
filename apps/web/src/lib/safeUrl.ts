// URLs in source data (tender feeds, scraped evidence, AI research) are
// untrusted. React 18 still renders `javascript:` hrefs, so any link built from
// data goes through here: only absolute http(s) URLs survive; anything else is
// shown as plain text by the caller.
export function safeExternalUrl(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url.trim())
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null
  } catch {
    return null
  }
}
