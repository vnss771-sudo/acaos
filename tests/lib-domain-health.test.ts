// Unit tests for the sending-domain health checks and the scheduled sweep. DNS is
// replaced by an in-memory resolver and the database by a fake client, so every
// case is hermetic.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkDomainHealth, classifyBlocklistAnswer, dmarcPolicy, sendingDomainOf, newProblems,
  runDomainHealthSweep, domainBlocklists, DEFAULT_DOMAIN_BLOCKLISTS,
  buildDomainHealthEmail, emailWorkspaceAdmins,
  type DomainHealthResolver, type DomainHealthReport,
} from '../packages/backend-core/src/lib/domainHealth.ts'

const dnsError = (code: string) => Object.assign(new Error(code), { code })

// TXT / A answers keyed by name; a string value is an error code to throw.
function fakeResolver(txt: Record<string, string[][] | string>, a: Record<string, string[] | string> = {}): DomainHealthResolver & { queried: string[] } {
  const queried: string[] = []
  const answer = <T>(table: Record<string, T | string>, name: string): T => {
    queried.push(name)
    const v = table[name]
    if (v === undefined) throw dnsError('ENOTFOUND')
    if (typeof v === 'string') throw dnsError(v)
    return v
  }
  return {
    queried,
    resolveTxt: async (name) => answer(txt, name),
    resolve4: async (name) => answer(a, name),
  }
}

const HEALTHY_TXT = {
  'example.com': [['v=spf1 include:_spf.google.com ~all'], ['google-site-verification=abc']],
  'google._domainkey.example.com': [['v=DKIM1; k=rsa; p=MIIB', 'IjANBgkq']],
  '_dmarc.example.com': [['v=DMARC1; p=reject; rua=mailto:d@example.com']],
}
const ZONES = ['dbl.test', 'uri.test']

test('a fully configured, unlisted domain is healthy', async () => {
  const r = await checkDomainHealth('Example.COM.', { resolver: fakeResolver(HEALTHY_TXT), blocklists: ZONES })
  assert.equal(r.domain, 'example.com')
  assert.equal(r.status, 'healthy')
  assert.deepEqual(r.spf, { status: 'ok', records: ['v=spf1 include:_spf.google.com ~all'] })
  assert.equal(r.dkim.status, 'ok')
  assert.equal(r.dkim.selector, 'google')
  assert.deepEqual({ status: r.dmarc.status, policy: r.dmarc.policy, foundAt: r.dmarc.foundAt }, { status: 'ok', policy: 'reject', foundAt: 'example.com' })
  assert.deepEqual(r.blocklists.map((b) => b.status), ['clean', 'clean'])
  assert.deepEqual(r.issues, [])
})

test('TXT records split into chunks are joined before matching', async () => {
  const r = await checkDomainHealth('example.com', {
    resolver: fakeResolver({ ...HEALTHY_TXT, 'example.com': [['v=spf1 include:a.test ', 'include:b.test -all']] }),
    blocklists: [],
  })
  assert.deepEqual(r.spf.records, ['v=spf1 include:a.test include:b.test -all'])
})

test('missing SPF is critical; missing DKIM and DMARC are warnings', async () => {
  const r = await checkDomainHealth('example.com', { resolver: fakeResolver({}), blocklists: [] })
  assert.equal(r.status, 'critical')
  assert.deepEqual(r.issues.map((i) => [i.code, i.severity]), [
    ['spf_missing', 'critical'], ['dkim_not_found', 'warning'], ['dmarc_missing', 'warning'],
  ])
})

test('two SPF records are a critical permerror', async () => {
  const r = await checkDomainHealth('example.com', {
    resolver: fakeResolver({ ...HEALTHY_TXT, 'example.com': [['v=spf1 -all'], ['v=spf1 include:x.test -all']] }),
    blocklists: [],
  })
  assert.equal(r.spf.status, 'multiple')
  assert.equal(r.status, 'critical')
})

test('only warnings gives a warning status; p=none is informational', async () => {
  const r = await checkDomainHealth('example.com', {
    resolver: fakeResolver({ 'example.com': HEALTHY_TXT['example.com'], '_dmarc.example.com': [['v=DMARC1; p=none']] }),
    blocklists: [],
  })
  assert.equal(r.status, 'warning')
  assert.deepEqual(r.issues.map((i) => i.code), ['dkim_not_found', 'dmarc_policy_none'])
})

test('a DNS failure is undetermined, never reported as a missing record', async () => {
  const r = await checkDomainHealth('example.com', {
    resolver: fakeResolver({ ...HEALTHY_TXT, 'example.com': 'ETIMEOUT' }),
    blocklists: [],
  })
  assert.equal(r.spf.status, 'error')
  assert.equal(r.status, 'unknown')
  assert.ok(!r.issues.some((i) => i.code === 'spf_missing'))
})

test('a critical finding still wins over an undetermined lookup', async () => {
  const r = await checkDomainHealth('example.com', {
    resolver: fakeResolver({ '_dmarc.example.com': 'ESERVFAIL' }),
    blocklists: [],
  })
  assert.equal(r.dmarc.status, 'error')
  assert.equal(r.status, 'critical')
})

test('DMARC falls back to the parent domain for a subdomain sender', async () => {
  const resolver = fakeResolver({
    'mail.example.com': [['v=spf1 -all']],
    'google._domainkey.mail.example.com': [['v=DKIM1; p=x']],
    '_dmarc.example.com': [['v=DMARC1;p=quarantine']],
  })
  const r = await checkDomainHealth('mail.example.com', { resolver, blocklists: [] })
  assert.deepEqual({ status: r.dmarc.status, policy: r.dmarc.policy, foundAt: r.dmarc.foundAt }, { status: 'ok', policy: 'quarantine', foundAt: 'example.com' })
  assert.ok(resolver.queried.includes('_dmarc.mail.example.com'))
  assert.equal(r.status, 'healthy')
})

test('a custom DKIM selector is probed instead of the common list', async () => {
  const resolver = fakeResolver({ ...HEALTHY_TXT, 'sel9._domainkey.example.com': [['v=DKIM1; p=y']] })
  const r = await checkDomainHealth('example.com', { resolver, dkimSelectors: ['sel9'], blocklists: [] })
  assert.equal(r.dkim.selector, 'sel9')
  assert.ok(!resolver.queried.includes('google._domainkey.example.com'))
})

test('a blocklist listing is critical and names the list', async () => {
  const r = await checkDomainHealth('example.com', {
    resolver: fakeResolver(HEALTHY_TXT, { 'example.com.dbl.test': ['127.0.1.2'] }),
    blocklists: ZONES,
  })
  assert.equal(r.status, 'critical')
  assert.deepEqual(r.blocklists, [
    { zone: 'dbl.test', status: 'listed', code: '127.0.1.2' },
    { zone: 'uri.test', status: 'clean', code: null },
  ])
  assert.deepEqual(r.issues.map((i) => i.code), ['blocklisted:dbl.test'])
})

test('refused or failed blocklist queries are errors, not listings', async () => {
  const r = await checkDomainHealth('example.com', {
    resolver: fakeResolver(HEALTHY_TXT, { 'example.com.dbl.test': ['127.255.255.254'], 'example.com.uri.test': 'ETIMEOUT' }),
    blocklists: ZONES,
  })
  assert.deepEqual(r.blocklists.map((b) => b.status), ['error', 'error'])
  assert.equal(r.status, 'healthy')
})

test('classifyBlocklistAnswer', () => {
  for (const a of ['127.0.0.2', '127.0.0.4', '127.0.1.2', '127.0.1.106']) assert.equal(classifyBlocklistAnswer([a]), 'listed', a)
  for (const a of ['127.0.0.1', '127.0.1.255', '127.255.255.252', '127.255.255.254', '93.184.216.34', '']) {
    assert.equal(classifyBlocklistAnswer([a]), 'error', a)
  }
})

test('dmarcPolicy reads the p= tag', () => {
  assert.equal(dmarcPolicy('v=DMARC1; p=reject; sp=none'), 'reject')
  assert.equal(dmarcPolicy('v=DMARC1;p=Quarantine'), 'quarantine')
  assert.equal(dmarcPolicy('v=DMARC1; sp=reject'), null)
})

test('sendingDomainOf extracts the domain from a From value', () => {
  assert.equal(sendingDomainOf('Acme <Sales@Acme.io>'), 'acme.io')
  assert.equal(sendingDomainOf('ops@mail.acme.co.uk'), 'mail.acme.co.uk')
  assert.equal(sendingDomainOf('noreply@localhost'), null)
  assert.equal(sendingDomainOf('no-at-sign'), null)
  assert.equal(sendingDomainOf(null), null)
})

test('domainBlocklists honours the env override and `none`', () => {
  const prev = process.env.DOMAIN_BLOCKLISTS
  try {
    delete process.env.DOMAIN_BLOCKLISTS
    assert.deepEqual(domainBlocklists(), DEFAULT_DOMAIN_BLOCKLISTS)
    process.env.DOMAIN_BLOCKLISTS = ' A.test , b.test '
    assert.deepEqual(domainBlocklists(), ['a.test', 'b.test'])
    process.env.DOMAIN_BLOCKLISTS = 'none'
    assert.deepEqual(domainBlocklists(), [])
  } finally {
    if (prev === undefined) delete process.env.DOMAIN_BLOCKLISTS
    else process.env.DOMAIN_BLOCKLISTS = prev
  }
})

function report(domain: string, status: DomainHealthReport['status'], codes: Array<[string, 'critical' | 'warning' | 'info']> = []): DomainHealthReport {
  return {
    domain, checkedAt: '2026-09-23T00:00:00.000Z', status,
    spf: { status: 'ok', records: [] }, dkim: { status: 'ok', selector: null, checkedSelectors: [] },
    dmarc: { status: 'ok', record: null, policy: null, foundAt: null }, blocklists: [],
    issues: codes.map(([code, severity]) => ({ code, severity, message: code })),
  }
}

test('newProblems reports only warning/critical issues that are new', () => {
  const prev = report('a.test', 'warning', [['dmarc_missing', 'warning']])
  const next = report('a.test', 'critical', [['dmarc_missing', 'warning'], ['blocklisted:x', 'critical'], ['dmarc_policy_none', 'info']])
  assert.deepEqual(newProblems(prev, next).map((i) => i.code), ['blocklisted:x'])
  assert.deepEqual(newProblems(null, next).map((i) => i.code), ['dmarc_missing', 'blocklisted:x'])
  assert.deepEqual(newProblems(next, prev), [])
})

function fakeDb(rows: Array<{ workspaceId: string; smtpFrom: string | null; domainHealth: unknown }>) {
  const updates: Array<{ workspaceId: string; domainHealth: DomainHealthReport }> = []
  return {
    updates,
    client: {
      workspaceEmailConfig: {
        findMany: async () => rows,
        update: async (a: any) => { updates.push({ workspaceId: a.where.workspaceId, domainHealth: a.data.domainHealth }); return {} },
      },
    } as any,
  }
}

test('the sweep checks each domain once, stores reports and alerts only on new problems', async () => {
  const { client, updates } = fakeDb([
    { workspaceId: 'w1', smtpFrom: 'A <a@shared.test>', domainHealth: null },
    { workspaceId: 'w2', smtpFrom: 'b@shared.test', domainHealth: report('shared.test', 'critical', [['spf_missing', 'critical']]) },
    { workspaceId: 'w3', smtpFrom: 'c@fine.test', domainHealth: null },
    { workspaceId: 'w4', smtpFrom: 'not-an-address', domainHealth: null },
  ])
  const checked: string[] = []
  const alerts: Array<[string, string[]]> = []
  const r = await runDomainHealthSweep({
    client,
    check: async (d) => { checked.push(d); return d === 'shared.test' ? report(d, 'critical', [['spf_missing', 'critical']]) : report(d, 'healthy') },
    alert: async (ws, _rep, problems) => { alerts.push([ws, problems.map((p) => p.code)]) },
  })
  assert.deepEqual(checked.sort(), ['fine.test', 'shared.test'])
  assert.deepEqual(updates.map((u) => u.workspaceId), ['w1', 'w2', 'w3'])
  // w1 had no baseline so it hears about the problem; w2 already knew.
  assert.deepEqual(alerts, [['w1', ['spf_missing']]])
  assert.deepEqual(r, { workspaces: 3, domains: 2, degraded: 1, unknown: 0 })
})

test('the sweep keeps the last conclusive report when a check is undetermined', async () => {
  const { client, updates } = fakeDb([{ workspaceId: 'w1', smtpFrom: 'a@x.test', domainHealth: report('x.test', 'healthy') }])
  const alerts: string[] = []
  const r = await runDomainHealthSweep({ client, check: async (d) => report(d, 'unknown'), alert: async (ws) => { alerts.push(ws) } })
  assert.deepEqual(updates, [])
  assert.deepEqual(alerts, [])
  assert.equal(r.unknown, 1)
})

test('a changed sending domain starts a fresh baseline', async () => {
  const { client } = fakeDb([{ workspaceId: 'w1', smtpFrom: 'a@new.test', domainHealth: report('old.test', 'warning', [['dmarc_missing', 'warning']]) }])
  const alerts: Array<string[]> = []
  await runDomainHealthSweep({
    client,
    check: async (d) => report(d, 'warning', [['dmarc_missing', 'warning']]),
    alert: async (_ws, _r, problems) => { alerts.push(problems.map((p) => p.code)) },
  })
  assert.deepEqual(alerts, [['dmarc_missing']])
})

test('a failing alert does not abort the sweep', async () => {
  const { client, updates } = fakeDb([
    { workspaceId: 'w1', smtpFrom: 'a@x.test', domainHealth: null },
    { workspaceId: 'w2', smtpFrom: 'b@y.test', domainHealth: null },
  ])
  const r = await runDomainHealthSweep({
    client,
    check: async (d) => report(d, 'critical', [['spf_missing', 'critical']]),
    alert: async () => { throw new Error('webhook down') },
  })
  assert.equal(updates.length, 2)
  assert.equal(r.degraded, 2)
})

test('the alert email escapes workspace-controlled values and names each new problem', () => {
  const rep = report('acme.test', 'critical')
  const problems = [
    { code: 'spf_missing', severity: 'critical' as const, message: 'No SPF <record>.' },
    { code: 'dmarc_missing', severity: 'warning' as const, message: 'No DMARC record.' },
  ]
  const e = buildDomainHealthEmail({
    workspaceName: 'Evil <b>Co</b>\r\nBcc: x@y.test', report: rep, problems, settingsUrl: 'https://app.test/settings?a=1&b="2"',
  })
  assert.equal(e.subject, 'Action required: sending domain acme.test has 2 new problems (Evil <b>Co</b> Bcc: x@y.test)')
  assert.ok(!/[\r\n]/.test(e.subject), 'subject has no line breaks')
  assert.ok(e.html.includes('Evil &lt;b&gt;Co&lt;/b&gt;'))
  assert.ok(!e.html.includes('<b>Co</b>'))
  assert.ok(e.html.includes('<strong>Critical:</strong> No SPF &lt;record&gt;.'))
  assert.ok(e.html.includes('href="https://app.test/settings?a=1&amp;b=&quot;2&quot;"'))
  assert.ok(e.html.includes('likely to be rejected'))
  assert.ok(e.text.includes('- Warning: No DMARC record.'))
})

test('a warning-only alert is not phrased as action required', () => {
  const e = buildDomainHealthEmail({
    workspaceName: 'Acme', report: report('acme.test', 'warning'),
    problems: [{ code: 'dmarc_missing', severity: 'warning', message: 'No DMARC record.' }], settingsUrl: 'https://app.test/settings',
  })
  assert.equal(e.subject, 'Heads up: sending domain acme.test has a new problem (Acme)')
  assert.ok(!e.html.includes('likely to be rejected'))
})

function adminDb(emails: string[]) {
  const queries: any[] = []
  return {
    queries,
    client: {
      workspace: { findUnique: async () => ({ name: 'Acme' }) },
      membership: { findMany: async (a: any) => { queries.push(a); return emails.map((email) => ({ user: { email } })) } },
    },
  }
}
const PROBLEM = [{ code: 'spf_missing', severity: 'critical' as const, message: 'No SPF record.' }]

test('admin alerts go to each verified owner/admin once, through the platform relay', async () => {
  const { client, queries } = adminDb(['a@acme.test', 'b@acme.test', 'a@acme.test'])
  const sent: Array<{ to: string; cfg: unknown; text?: string }> = []
  const n = await emailWorkspaceAdmins('w1', report('acme.test', 'critical'), PROBLEM, {
    client, mailConfigured: () => true,
    send: (async (to: string, _s: string, _h: string, cfg: unknown, opts?: { text?: string }) => { sent.push({ to, cfg, text: opts?.text }); return {} }) as any,
  })
  assert.equal(n, 2)
  assert.deepEqual(sent.map((m) => m.to), ['a@acme.test', 'b@acme.test'])
  assert.ok(sent.every((m) => m.cfg === null), 'never the workspace SMTP config')
  assert.ok(sent[0]!.text?.includes('No SPF record.'))
  assert.deepEqual(queries[0].where, { workspaceId: 'w1', role: { in: ['owner', 'admin'] }, user: { emailVerified: true } })
})

test('admin alerts are skipped when disabled or when platform mail is not configured', async () => {
  const send = (async () => { throw new Error('should not send') }) as any
  const prev = process.env.DOMAIN_HEALTH_EMAIL_ALERTS
  try {
    process.env.DOMAIN_HEALTH_EMAIL_ALERTS = 'false'
    assert.equal(await emailWorkspaceAdmins('w1', report('a.test', 'critical'), PROBLEM, { client: adminDb(['a@a.test']).client, send, mailConfigured: () => true }), 0)
    delete process.env.DOMAIN_HEALTH_EMAIL_ALERTS
    assert.equal(await emailWorkspaceAdmins('w1', report('a.test', 'critical'), PROBLEM, { client: adminDb(['a@a.test']).client, send, mailConfigured: () => false }), 0)
  } finally {
    if (prev === undefined) delete process.env.DOMAIN_HEALTH_EMAIL_ALERTS
    else process.env.DOMAIN_HEALTH_EMAIL_ALERTS = prev
  }
})

test('one failed admin email does not stop the others, and nothing throws', async () => {
  const sent: string[] = []
  const n = await emailWorkspaceAdmins('w1', report('a.test', 'critical'), PROBLEM, {
    client: adminDb(['bad@a.test', 'ok@a.test']).client, mailConfigured: () => true,
    send: (async (to: string) => { if (to.startsWith('bad')) throw new Error('550'); sent.push(to); return {} }) as any,
  })
  assert.equal(n, 1)
  assert.deepEqual(sent, ['ok@a.test'])
  const broken = { workspace: { findUnique: async () => { throw new Error('db down') } }, membership: { findMany: async () => [] } } as any
  assert.equal(await emailWorkspaceAdmins('w1', report('a.test', 'critical'), PROBLEM, { client: broken, mailConfigured: () => true }), 0)
})
