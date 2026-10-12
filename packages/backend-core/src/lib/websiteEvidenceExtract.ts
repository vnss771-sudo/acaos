/** E3.2 deterministic, read-only extraction. Web text is data, never instructions or consent. */
import { createHash } from 'node:crypto'
import type { WebsiteDocument } from './websiteEvidenceFetch.js'

const MAX_INPUT_CHARS = 512 * 1024
const MAX_OUTPUT_CHARS = 24_000
const MAX_CLAIMS = 20
const MAX_QUOTE = 360
const MAX_TITLE = 160

export type ObservedWebsiteClaim = Readonly<{
  id: string
  quote: string
  category: 'contact' | 'service' | 'project' | 'general'
  verification: 'source_observed'
  confidence: 'unverified'
  sourceUrl: string
  capturedAt: string
  sourceHash: string
}>
export type WebsiteEvidenceExtraction = Readonly<{
  sourceUrl: string
  capturedAt: string
  sourceHash: string
  title: string | null
  pageText: string
  claims: readonly ObservedWebsiteClaim[]
  warning: 'web_content_untrusted_not_consent'
  truncated: boolean
}>

function decodeEntities(text: string): string {
  const known: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…' }
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,10});/gi, (all, code: string) => {
    if (code[0] === '#') {
      const n = code[1]?.toLowerCase() === 'x' ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10)
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : ' '
    }
    return known[code.toLowerCase()] ?? all
  })
}

function normalizeText(input: string): string {
  // Replace control characters (C0 + DEL) by code point; avoids a control-character regex literal.
  const decoded = decodeEntities(input)
  let cleaned = ''
  for (const ch of decoded) { const c = ch.codePointAt(0)!; cleaned += c < 32 || c === 127 ? ' ' : ch }
  return cleaned.replace(/\s+/g, ' ').trim()
}

/** Best-effort, deliberately restrictive HTML text extraction; not a browser parser. */
function visibleText(html: string): { title: string | null; text: string } {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|template|svg|noscript|iframe|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] ?? null
  // Strip all tags instead of evaluating attributes, JSON-LD or links as evidence.
  const text = stripped.replace(/<[^>]*>/g, ' ')
  return { title: title ? normalizeText(title.replace(/<[^>]*>/g, ' ')).slice(0, MAX_TITLE) || null : null, text: normalizeText(text) }
}

function categoryFor(sentence: string): ObservedWebsiteClaim['category'] {
  if (/\b(contact|email|telephone|phone|call us|enquiries)\b/i.test(sentence)) return 'contact'
  if (/\b(project|construction|contract|tender|development|completed|awarded)\b/i.test(sentence)) return 'project'
  if (/\b(services?|install|maintenance|repair|electrical|plumbing|hvac|building|specialis(?:e|t))\b/i.test(sentence)) return 'service'
  return 'general'
}

/** Exact excerpts only; never infer factual truth from page text or accept page commands. */
export function extractWebsiteEvidence(doc: WebsiteDocument): WebsiteEvidenceExtraction {
  const safeUrl = new URL(doc.sourceUrl)
  if (safeUrl.protocol !== 'https:' || safeUrl.search || safeUrl.hash || safeUrl.username || safeUrl.password) throw new Error('unsupported_evidence_source')
  if (!/^text\/(html|plain)(?:\s*;|\s*$)/i.test(doc.contentType)) throw new Error('unsupported_evidence_type')
  if (!Number.isFinite(Date.parse(doc.retrievedAt))) throw new Error('invalid_capture_time')
  const limited = doc.text.slice(0, MAX_INPUT_CHARS)
  const sourceHash = createHash('sha256').update(doc.text, 'utf8').digest('hex')
  const html = /^text\/html/i.test(doc.contentType)
  const parsed = html ? visibleText(limited) : { title: null, text: normalizeText(limited) }
  const pageText = parsed.text.slice(0, MAX_OUTPUT_CHARS)
  const claims: ObservedWebsiteClaim[] = []
  const seen = new Set<string>()
  // No AI model or semantic inference: sentences only, exact excerpts from pageText.
  for (const segment of pageText.split(/(?<=[.!?])\s+|\s*\n+\s*/)) {
    const quote = segment.trim()
    if (quote.length < 35 || quote.length > MAX_QUOTE) continue
    const key = quote.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    claims.push({
      id: createHash('sha256').update(`${safeUrl.href}\n${sourceHash}\n${quote}`).digest('hex'),
      quote, category: categoryFor(quote), verification: 'source_observed', confidence: 'unverified',
      sourceUrl: safeUrl.href, capturedAt: doc.retrievedAt, sourceHash,
    })
    if (claims.length >= MAX_CLAIMS) break
  }
  return {
    sourceUrl: safeUrl.href, capturedAt: doc.retrievedAt, sourceHash, title: parsed.title,
    pageText, claims, warning: 'web_content_untrusted_not_consent',
    truncated: doc.text.length > MAX_INPUT_CHARS || parsed.text.length > MAX_OUTPUT_CHARS,
  }
}
