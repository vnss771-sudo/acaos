// Sending-domain health: SPF, DKIM, DMARC and domain blocklist (DNSBL) checks.
//
// Used two ways: on demand from GET /api/mailbox/check-domain, and by the worker's
// scheduled domain-health sweep, which re-checks every workspace's sending domain
// (the domain of WorkspaceEmailConfig.smtpFrom), stores the latest report, and
// alerts the workspace (audit event, `domain.health_degraded` webhook, and an
// email to its owners/admins) when a new warning or critical issue appears.
//
// The DNS layer is injected (DomainHealthResolver) so the classification logic is
// unit-tested without network access. Lookup failures other than "no such record"
// (timeouts, SERVFAIL) are reported as errors, never as a missing record, so a DNS
// hiccup can't raise a false "SPF missing" alarm.

import { Resolver } from 'node:dns/promises'
import type { PrismaClient } from '@prisma/client'
import { prisma } from './prisma.js'
import { recordAudit } from './audit.js'
import { emitWebhookEvent } from './webhooks.js'
import { logger } from './logger.js'
import { escapeHtml } from './html.js'
import { isMailConfigured, sendMail } from '../services/mail.js'

export type DomainHealthResolver = {
  resolveTxt(name: string): Promise<string[][]>
  resolve4(name: string): Promise<string[]>
}

// DKIM keys live at <selector>._domainkey.<domain>. Without a known selector we
// probe the ones the major providers use.
export const COMMON_DKIM_SELECTORS = ['google', 'default', 'selector1', 'selector2', 'k1', 'dkim', 'mail', 's1']

// Domain-based blocklists (they list domains, not sending IPs). Override with
// DOMAIN_BLOCKLISTS (comma-separated zones), or set it to `none` to skip them.
// Spamhaus's free service is for low-volume, non-commercial use and refuses
// queries made through large public resolvers; a production deployment should use
// its own resolver or a Spamhaus DQS zone (e.g. <key>.dbl.dq.spamhaus.net).
export const DEFAULT_DOMAIN_BLOCKLISTS = ['dbl.spamhaus.org', 'multi.surbl.org', 'multi.uribl.com']

export function domainBlocklists(): string[] {
  const raw = process.env.DOMAIN_BLOCKLISTS
  if (raw === undefined || raw.trim() === '') return DEFAULT_DOMAIN_BLOCKLISTS
  if (raw.trim().toLowerCase() === 'none') return []
  return raw.split(',').map((z) => z.trim().toLowerCase()).filter(Boolean)
}

export type LookupStatus = 'ok' | 'missing' | 'error'
export type IssueSeverity = 'critical' | 'warning' | 'info'
export type DomainHealthStatus = 'healthy' | 'warning' | 'critical' | 'unknown'
export type DomainHealthIssue = { code: string; severity: IssueSeverity; message: string }

export type DomainHealthReport = {
  domain: string
  checkedAt: string
  status: DomainHealthStatus
  spf: { status: LookupStatus | 'multiple'; records: string[] }
  dkim: { status: LookupStatus; selector: string | null; checkedSelectors: string[] }
  dmarc: { status: LookupStatus; record: string | null; policy: string | null; foundAt: string | null }
  blocklists: Array<{ zone: string; status: 'listed' | 'clean' | 'error'; code: string | null }>
  issues: DomainHealthIssue[]
}

/** The DNS name a DKIM TXT record for `selector` lives at. */
export function dkimQueryName(selector: string, domain: string): string {
  return `${selector}._domainkey.${domain}`
}

/** True if the (possibly multi-chunk) TXT record is a DKIM key. */
export function isDkimRecord(txtChunks: string[]): boolean {
  return /v=DKIM1/i.test(txtChunks.join(''))
}

// "No such record" answers. Anything else (ETIMEOUT, ESERVFAIL, ECONNREFUSED) is a
// lookup failure we can't draw a conclusion from.
const NO_RECORD_CODES = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN'])
function isNoRecord(err: unknown): boolean {
  return NO_RECORD_CODES.has((err as { code?: string })?.code ?? '')
}

type TxtLookup = { status: 'found'; records: string[] } | { status: 'none' } | { status: 'error' }

// A TXT record may arrive split into 255-byte chunks; join each record's chunks
// back together before matching on its prefix.
async function lookupTxt(resolver: DomainHealthResolver, name: string): Promise<TxtLookup> {
  try {
    return { status: 'found', records: (await resolver.resolveTxt(name)).map((chunks) => chunks.join('')) }
  } catch (err) {
    return isNoRecord(err) ? { status: 'none' } : { status: 'error' }
  }
}

/** The p= tag of a DMARC record (none | quarantine | reject), or null. */
export function dmarcPolicy(record: string): string | null {
  const m = record.match(/(?:^|;)\s*p\s*=\s*([a-z]+)/i)
  return m ? (m[1] as string).toLowerCase() : null
}

// DMARC falls back to the organizational domain when a subdomain has no record of
// its own. Without a public-suffix list we walk up the labels, stopping at two
// (a `_dmarc.co.uk` lookup simply finds nothing).
function dmarcCandidates(domain: string): string[] {
  const labels = domain.split('.')
  const out: string[] = []
  for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join('.'))
  return out
}

/**
 * Classify a DNSBL A-record answer. Listings are 127.0.0.2 and up; 127.0.0.1 (URIBL
 * and SURBL "query refused"), anything ending in .255 and the 127.255.255.x range
 * (Spamhaus error codes) mean the list refused to answer, and a non-127 answer
 * usually means a resolver rewriting NXDOMAIN, so those are errors, not listings.
 */
export function classifyBlocklistAnswer(addresses: string[]): 'listed' | 'error' {
  const a = addresses[0] ?? ''
  if (!a.startsWith('127.')) return 'error'
  if (a === '127.0.0.1' || a.startsWith('127.255.255.') || a.endsWith('.255')) return 'error'
  return 'listed'
}

async function checkBlocklist(resolver: DomainHealthResolver, domain: string, zone: string): Promise<DomainHealthReport['blocklists'][number]> {
  try {
    const addrs = await resolver.resolve4(`${domain}.${zone}`)
    const status = classifyBlocklistAnswer(addrs)
    return { zone, status, code: addrs[0] ?? null }
  } catch (err) {
    return { zone, status: isNoRecord(err) ? 'clean' : 'error', code: null }
  }
}

function defaultResolver(): DomainHealthResolver {
  // Bounded: 3s per try, 2 tries, so a dead nameserver can't stall a sweep.
  return new Resolver({ timeout: 3000, tries: 2 })
}

export type CheckDomainOptions = {
  resolver?: DomainHealthResolver
  dkimSelectors?: string[]
  blocklists?: string[]
  now?: () => Date
}

/** Run every check against `domain` and summarize the result. Never throws. */
export async function checkDomainHealth(domain: string, opts: CheckDomainOptions = {}): Promise<DomainHealthReport> {
  const resolver = opts.resolver ?? defaultResolver()
  const selectors = opts.dkimSelectors?.length ? opts.dkimSelectors : COMMON_DKIM_SELECTORS
  const zones = opts.blocklists ?? domainBlocklists()
  const d = domain.trim().toLowerCase().replace(/\.$/, '')

  const [rootTxt, dkimProbes, dmarcLookups, blocklists] = await Promise.all([
    lookupTxt(resolver, d),
    Promise.all(selectors.map(async (sel) => ({ sel, res: await lookupTxt(resolver, dkimQueryName(sel, d)) }))),
    Promise.all(dmarcCandidates(d).map(async (name) => ({ name, res: await lookupTxt(resolver, `_dmarc.${name}`) }))),
    Promise.all(zones.map((zone) => checkBlocklist(resolver, d, zone))),
  ])

  // SPF: exactly one v=spf1 record at the root. Two or more is a permerror.
  const spfRecords = rootTxt.status === 'found' ? rootTxt.records.filter((r) => /^v=spf1(\s|$)/i.test(r)) : []
  const spf: DomainHealthReport['spf'] = {
    status: rootTxt.status === 'error' ? 'error' : spfRecords.length === 0 ? 'missing' : spfRecords.length > 1 ? 'multiple' : 'ok',
    records: spfRecords,
  }

  // DKIM: found on any probed selector. Only "missing" if every probe answered
  // cleanly; any failed probe leaves the result undetermined.
  const dkimHit = dkimProbes.find((p) => p.res.status === 'found' && p.res.records.some((r) => isDkimRecord([r])))
  const dkim: DomainHealthReport['dkim'] = {
    status: dkimHit ? 'ok' : dkimProbes.some((p) => p.res.status === 'error') ? 'error' : 'missing',
    selector: dkimHit?.sel ?? null,
    checkedSelectors: selectors,
  }

  // DMARC: the most specific name that answers decides. An error on a more specific
  // name makes the result undetermined rather than falling through.
  let dmarc: DomainHealthReport['dmarc'] = { status: 'missing', record: null, policy: null, foundAt: null }
  for (const { name, res } of dmarcLookups) {
    if (res.status === 'error') { dmarc = { ...dmarc, status: 'error' }; break }
    const rec = res.status === 'found' ? res.records.find((r) => /^v=DMARC1(\s|;|$)/i.test(r)) : undefined
    if (rec) { dmarc = { status: 'ok', record: rec, policy: dmarcPolicy(rec), foundAt: name }; break }
  }

  const issues: DomainHealthIssue[] = []
  if (spf.status === 'missing') issues.push({ code: 'spf_missing', severity: 'critical', message: 'No SPF record. Mailbox providers will reject or spam-folder mail from this domain.' })
  if (spf.status === 'multiple') issues.push({ code: 'spf_multiple', severity: 'critical', message: 'More than one SPF record. SPF fails with a permanent error until they are merged into one.' })
  if (dkim.status === 'missing') issues.push({ code: 'dkim_not_found', severity: 'warning', message: `No DKIM key found on the common selectors (${selectors.join(', ')}). If you use a custom selector, check it directly.` })
  if (dmarc.status === 'missing') issues.push({ code: 'dmarc_missing', severity: 'warning', message: 'No DMARC record. Gmail and Yahoo require one for bulk senders.' })
  if (dmarc.status === 'ok' && dmarc.policy === 'none') issues.push({ code: 'dmarc_policy_none', severity: 'info', message: 'DMARC policy is p=none (monitoring only).' })
  for (const b of blocklists) {
    if (b.status === 'listed') issues.push({ code: `blocklisted:${b.zone}`, severity: 'critical', message: `Domain is listed on ${b.zone} (${b.code}).` })
  }

  const undetermined = spf.status === 'error' || dkim.status === 'error' || dmarc.status === 'error'
  const status: DomainHealthStatus = issues.some((i) => i.severity === 'critical')
    ? 'critical'
    : undetermined
      ? 'unknown'
      : issues.some((i) => i.severity === 'warning') ? 'warning' : 'healthy'

  return {
    domain: d,
    checkedAt: (opts.now?.() ?? new Date()).toISOString(),
    status,
    spf,
    dkim,
    dmarc,
    blocklists,
    issues,
  }
}

/** Warning/critical issues in `next` that were not present in `prev`. */
export function newProblems(prev: DomainHealthReport | null, next: DomainHealthReport): DomainHealthIssue[] {
  const before = new Set((prev?.issues ?? []).map((i) => i.code))
  return next.issues.filter((i) => i.severity !== 'info' && !before.has(i.code))
}

/** The domain part of a From value such as `Name <a@b.com>` or `a@b.com`. */
export function sendingDomainOf(from: string | null | undefined): string | null {
  if (!from) return null
  const addr = from.match(/<([^>]+)>/)?.[1] ?? from
  const at = addr.lastIndexOf('@')
  if (at === -1) return null
  const domain = addr.slice(at + 1).trim().toLowerCase().replace(/\.$/, '')
  return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(domain) ? domain : null
}

export function isDomainHealthEnabled(): boolean {
  return process.env.DOMAIN_HEALTH_ENABLED !== 'false'
}

export function domainHealthIntervalMs(): number {
  const n = Number(process.env.DOMAIN_HEALTH_INTERVAL_MS)
  return Number.isFinite(n) && n >= 60_000 ? n : 24 * 60 * 60 * 1000
}

type Db = Pick<PrismaClient, 'workspaceEmailConfig'>

export type SweepResult = { workspaces: number; domains: number; degraded: number; unknown: number }

/**
 * Re-check the sending domain of every workspace with an SMTP From address. Each
 * domain is checked once per sweep even when several workspaces share it. An
 * `unknown` result (DNS failures) is not stored, so the last conclusive report
 * stays the baseline and a later recovery doesn't re-alert.
 */
export async function runDomainHealthSweep(deps: {
  client?: Db
  check?: (domain: string) => Promise<DomainHealthReport>
  alert?: (workspaceId: string, report: DomainHealthReport, problems: DomainHealthIssue[]) => Promise<void>
} = {}): Promise<SweepResult> {
  const client = deps.client ?? (prisma as unknown as Db)
  const check = deps.check ?? ((d: string) => checkDomainHealth(d))
  const alert = deps.alert ?? alertDegraded

  const configs = await client.workspaceEmailConfig.findMany({
    where: { smtpFrom: { not: null } },
    select: { workspaceId: true, smtpFrom: true, domainHealth: true },
  })

  const reports = new Map<string, Promise<DomainHealthReport>>()
  const result: SweepResult = { workspaces: 0, domains: 0, degraded: 0, unknown: 0 }

  for (const cfg of configs) {
    const domain = sendingDomainOf(cfg.smtpFrom)
    if (!domain) continue
    result.workspaces++
    if (!reports.has(domain)) reports.set(domain, check(domain))
    const report = await reports.get(domain)!
    if (report.status === 'unknown') { result.unknown++; continue }

    const prev = cfg.domainHealth as DomainHealthReport | null
    // A changed sending domain starts a fresh baseline.
    const baseline = prev && prev.domain === domain ? prev : null
    const problems = newProblems(baseline, report)

    await client.workspaceEmailConfig.update({
      where: { workspaceId: cfg.workspaceId },
      data: { domainHealth: report as object, domainHealthCheckedAt: new Date(report.checkedAt) },
    })
    if (problems.length > 0) {
      result.degraded++
      await alert(cfg.workspaceId, report, problems).catch((err) =>
        logger.warn('domain health alert failed', { workspaceId: cfg.workspaceId, error: (err as Error).message }))
    }
  }
  result.domains = reports.size
  return result
}

async function alertDegraded(workspaceId: string, report: DomainHealthReport, problems: DomainHealthIssue[]): Promise<void> {
  const payload = { domain: report.domain, status: report.status, newIssues: problems, report }
  await recordAudit({ workspaceId, type: 'domain.health_degraded', entityType: 'sending_domain', entityId: report.domain, metadata: payload })
  await emitWebhookEvent(workspaceId, 'domain.health_degraded', payload)
  await emailWorkspaceAdmins(workspaceId, report, problems)
}

export function areDomainHealthEmailsEnabled(): boolean {
  return process.env.DOMAIN_HEALTH_EMAIL_ALERTS !== 'false'
}

const SEVERITY_LABEL: Record<IssueSeverity, string> = { critical: 'Critical', warning: 'Warning', info: 'Info' }

/** Subject, HTML and plaintext for a domain-health alert. Every interpolated value is escaped. */
export function buildDomainHealthEmail(input: {
  workspaceName: string
  report: DomainHealthReport
  problems: DomainHealthIssue[]
  settingsUrl: string
}): { subject: string; html: string; text: string } {
  const { report, problems, settingsUrl } = input
  // Plain-text subject: strip line breaks so a workspace name can't inject headers.
  const workspaceName = input.workspaceName.replace(/[\r\n]+/g, ' ').trim() || 'your workspace'
  const critical = problems.some((p) => p.severity === 'critical')
  const subject = `${critical ? 'Action required' : 'Heads up'}: sending domain ${report.domain} has ${problems.length === 1 ? 'a new problem' : `${problems.length} new problems`} (${workspaceName})`

  const items = problems
    .map((p) => `<li><strong>${SEVERITY_LABEL[p.severity]}:</strong> ${escapeHtml(p.message)}</li>`)
    .join('')
  const html =
    `<p>The daily health check for <strong>${escapeHtml(report.domain)}</strong>, the sending domain of ` +
    `<strong>${escapeHtml(workspaceName)}</strong>, found ${problems.length === 1 ? 'a new problem' : 'new problems'}:</p>` +
    `<ul>${items}</ul>` +
    (critical ? '<p>Until this is fixed, mail from this domain is likely to be rejected or sent to spam.</p>' : '') +
    `<p><a href="${escapeHtml(settingsUrl)}">Review deliverability settings</a></p>` +
    '<p>You are receiving this because you are an owner or admin of this workspace. ' +
    'You will only be emailed again if another new problem appears.</p>'
  const text = [
    `The daily health check for ${report.domain}, the sending domain of ${workspaceName}, found ${problems.length === 1 ? 'a new problem' : 'new problems'}:`,
    '',
    ...problems.map((p) => `- ${SEVERITY_LABEL[p.severity]}: ${p.message}`),
    '',
    ...(critical ? ['Until this is fixed, mail from this domain is likely to be rejected or sent to spam.', ''] : []),
    `Review deliverability settings: ${settingsUrl}`,
    '',
    'You are receiving this because you are an owner or admin of this workspace. You will only be emailed again if another new problem appears.',
  ].join('\n')
  return { subject, html, text }
}

type AdminEmailDb = {
  workspace: { findUnique(args: { where: { id: string }; select: { name: true } }): Promise<{ name: string } | null> }
  membership: {
    findMany(args: {
      where: { workspaceId: string; role: { in: string[] }; user: { emailVerified: true } }
      select: { user: { select: { email: true } } }
    }): Promise<Array<{ user: { email: string } }>>
  }
}

/**
 * Email a domain-health alert to the workspace's owners and admins with a verified
 * address, one message each so recipients don't see each other. Sent through the
 * platform's SMTP relay, never the workspace's own SMTP: the domain being reported
 * on may be the reason the workspace's mail isn't arriving. Returns the number of
 * emails sent. Never throws.
 */
export async function emailWorkspaceAdmins(
  workspaceId: string,
  report: DomainHealthReport,
  problems: DomainHealthIssue[],
  deps: { client?: AdminEmailDb; send?: typeof sendMail; mailConfigured?: () => boolean } = {},
): Promise<number> {
  if (!areDomainHealthEmailsEnabled()) return 0
  if (!(deps.mailConfigured ?? (() => isMailConfigured()))()) return 0
  const client = deps.client ?? (prisma as unknown as AdminEmailDb)
  const send = deps.send ?? sendMail
  try {
    const [workspace, admins] = await Promise.all([
      client.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } }),
      client.membership.findMany({
        where: { workspaceId, role: { in: ['owner', 'admin'] }, user: { emailVerified: true } },
        select: { user: { select: { email: true } } },
      }),
    ])
    const recipients = [...new Set(admins.map((m) => m.user.email))]
    if (recipients.length === 0) return 0
    const appUrl = (process.env.APP_URL || 'http://localhost:5173').replace(/\/+$/, '')
    const email = buildDomainHealthEmail({ workspaceName: workspace?.name ?? '', report, problems, settingsUrl: `${appUrl}/settings` })
    let sent = 0
    for (const to of recipients) {
      try {
        await send(to, email.subject, email.html, null, { text: email.text })
        sent++
      } catch (err) {
        logger.warn('domain health email failed', { workspaceId, error: (err as Error).message })
      }
    }
    return sent
  } catch (err) {
    logger.warn('domain health email lookup failed', { workspaceId, error: (err as Error).message })
    return 0
  }
}
