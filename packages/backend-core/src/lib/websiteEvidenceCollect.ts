/**
 * E3.4: controlled, polite collection of website evidence for ONE prospect. Library only (no job is registered here).
 * Fail closed: flag off, bad URL, robots.txt unreadable/denying => nothing is fetched or stored. Never creates
 * Signals, consent or sends; claims stay `source_observed` / `unverified` (see websiteEvidenceStore).
 */
import { isWebsiteEvidenceEnabled } from './launchControls.js'
import { collectWebsiteDocument, WebsiteFetchError, type WebsiteDocument } from './websiteEvidenceFetch.js'
import { extractWebsiteEvidence } from './websiteEvidenceExtract.js'
import { saveWebsiteEvidence } from './websiteEvidenceStore.js'

export const EVIDENCE_PATHS = ['/', '/about', '/contact'] as const // fixed paths only; never follow links
export const MIN_REQUEST_SPACING_MS = 5_000
const UA_TOKEN = 'acaos-evidencefetcher'

export type RobotsRules = { allow: string[]; disallow: string[] }

/** Minimal RFC 9309 subset: our UA group wins over `*`; longest match wins; Allow beats Disallow on ties. */
export function parseRobots(text: string): RobotsRules {
  const groups: Array<{ agents: string[]; allow: string[]; disallow: string[] }> = []
  let cur: (typeof groups)[number] | null = null
  let lastWasAgent = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim()
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/)
    if (!m) continue
    const key = m[1]!.toLowerCase(); const val = m[2]!.trim()
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], allow: [], disallow: [] }; groups.push(cur) }
      cur.agents.push(val.toLowerCase()); lastWasAgent = true
      continue
    }
    lastWasAgent = false
    if (!cur) continue
    if (key === 'allow' && val) cur.allow.push(val)
    if (key === 'disallow' && val) cur.disallow.push(val)
  }
  const mine = groups.filter((g) => g.agents.some((a) => UA_TOKEN.includes(a) && a !== '*' && a !== ''))
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes('*'))
  return { allow: chosen.flatMap((g) => g.allow), disallow: chosen.flatMap((g) => g.disallow) }
}

function ruleMatches(rule: string, path: string): number {
  const end = rule.endsWith('$')
  const body = (end ? rule.slice(0, -1) : rule)
  const re = new RegExp('^' + body.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + (end ? '$' : ''))
  return re.test(path) ? body.replace(/\*/g, '').length : -1
}
export function isPathAllowed(rules: RobotsRules, path: string): boolean {
  const a = Math.max(-1, ...rules.allow.map((r) => ruleMatches(r, path)))
  const d = Math.max(-1, ...rules.disallow.map((r) => ruleMatches(r, path)))
  return d < 0 || a >= d
}

export type CollectDeps = {
  fetchDoc?: (url: string) => Promise<WebsiteDocument>
  sleep?: (ms: number) => Promise<void>
  now?: () => Date
}
export type PageOutcome = { path: string; outcome: 'saved' | 'robots_disallowed' | 'fetch_failed' | 'no_claims'; claims?: number; reason?: string }
export type CollectResult =
  | { status: 'disabled' | 'invalid_website' | 'robots_unavailable' | 'robots_disallows_all' }
  | { status: 'ok'; pages: PageOutcome[]; claimsSaved: number }

type SaveDb = Parameters<typeof saveWebsiteEvidence>[0]

/** `db` must be a transaction client; ownership of the prospect is re-checked by saveWebsiteEvidence. */
export async function collectProspectEvidence(
  db: SaveDb,
  input: { workspaceId: string; prospectId: string; website: string; retentionDays?: number },
  deps: CollectDeps = {},
): Promise<CollectResult> {
  if (!isWebsiteEvidenceEnabled()) return { status: 'disabled' }
  const fetchDoc = deps.fetchDoc ?? ((u: string) => collectWebsiteDocument(u))
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

  let origin: string
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(input.website) ? input.website : `https://${input.website}`)
    if (u.protocol !== 'https:') return { status: 'invalid_website' }
    origin = u.origin
  } catch { return { status: 'invalid_website' } }

  // robots.txt: 404/410 => no restrictions; anything else unreadable (401/403/5xx/network/timeouts) => deny.
  let rules: RobotsRules
  try {
    rules = parseRobots((await fetchDoc(`${origin}/robots.txt`)).text)
  } catch (e) {
    if (e instanceof WebsiteFetchError && e.reason === 'upstream_status' && (e.status === 404 || e.status === 410)) rules = { allow: [], disallow: [] }
    else return { status: 'robots_unavailable' }
  }
  if (!EVIDENCE_PATHS.some((p) => isPathAllowed(rules, p))) return { status: 'robots_disallows_all' }

  const pages: PageOutcome[] = []
  let claimsSaved = 0
  let first = true
  for (const path of EVIDENCE_PATHS) {
    if (!isPathAllowed(rules, path)) { pages.push({ path, outcome: 'robots_disallowed' }); continue }
    if (!first) await sleep(MIN_REQUEST_SPACING_MS)
    first = false
    try {
      const doc = await fetchDoc(`${origin}${path === '/' ? '/' : path}`)
      const extraction = extractWebsiteEvidence(doc)
      if (!extraction.claims.length) { pages.push({ path, outcome: 'no_claims' }); continue }
      const n = await saveWebsiteEvidence(db, { workspaceId: input.workspaceId, prospectId: input.prospectId, extraction, retentionDays: input.retentionDays }, deps.now?.())
      claimsSaved += n
      pages.push({ path, outcome: 'saved', claims: n })
    } catch (e) {
      // Ownership/contract errors from the store must not be swallowed as a mere page failure.
      if (e instanceof Error && /^(prospect_not_found_in_workspace|missing_scope|invalid_)/.test(e.message)) throw e
      pages.push({ path, outcome: 'fetch_failed', reason: e instanceof WebsiteFetchError ? e.reason : 'error' })
    }
  }
  return { status: 'ok', pages, claimsSaved }
}
