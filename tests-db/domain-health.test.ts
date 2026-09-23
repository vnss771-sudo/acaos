// DB-tier tests for the domain-health sweep and its admin email alerts against a
// real Postgres: the stored report round-trips through the JSON column, and the
// recipient query (owners/admins with a verified address, via the user relation)
// selects exactly the right people.

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { runDomainHealthSweep, emailWorkspaceAdmins, type DomainHealthReport } from '../packages/backend-core/src/lib/domainHealth.ts'
import { prisma, resetDb, disconnect, seedUser, seedUserWithWorkspace } from './helpers/db.ts'

after(async () => { await disconnect() })
beforeEach(async () => { await resetDb() })

function report(domain: string, codes: string[]): DomainHealthReport {
  return {
    domain, checkedAt: '2026-09-23T00:00:00.000Z', status: codes.length ? 'critical' : 'healthy',
    spf: { status: codes.includes('spf_missing') ? 'missing' : 'ok', records: [] },
    dkim: { status: 'ok', selector: 'google', checkedSelectors: ['google'] },
    dmarc: { status: 'ok', record: 'v=DMARC1; p=reject', policy: 'reject', foundAt: domain },
    blocklists: [],
    issues: codes.map((code) => ({ code, severity: 'critical' as const, message: code })),
  }
}

test('the sweep stores the report and only alerts again on a new problem', async () => {
  const { workspace } = await seedUserWithWorkspace()
  await prisma.workspaceEmailConfig.create({ data: { workspaceId: workspace.id, smtpFrom: 'Acme <hi@acme.test>' } })
  const alerts: string[][] = []
  const alert = async (_ws: string, _r: DomainHealthReport, problems: Array<{ code: string }>) => { alerts.push(problems.map((p) => p.code)) }

  await runDomainHealthSweep({ check: async (d) => report(d, ['spf_missing']), alert })
  const cfg = await prisma.workspaceEmailConfig.findUnique({ where: { workspaceId: workspace.id } })
  assert.equal((cfg!.domainHealth as DomainHealthReport).domain, 'acme.test')
  assert.equal(cfg!.domainHealthCheckedAt!.toISOString(), '2026-09-23T00:00:00.000Z')

  await runDomainHealthSweep({ check: async (d) => report(d, ['spf_missing']), alert })
  await runDomainHealthSweep({ check: async (d) => report(d, ['spf_missing', 'blocklisted:dbl.test']), alert })
  assert.deepEqual(alerts, [['spf_missing'], ['blocklisted:dbl.test']])
})

test('admin emails go to verified owners and admins only', async () => {
  const { workspace } = await seedUserWithWorkspace('owner@acme.test', 'owner')
  const admin = await seedUser('admin@acme.test')
  const member = await seedUser('member@acme.test')
  const unverifiedAdmin = await seedUser('unverified@acme.test', null, { emailVerified: false })
  const otherWsAdmin = await seedUserWithWorkspace('elsewhere@other.test', 'admin')
  await prisma.membership.createMany({
    data: [
      { workspaceId: workspace.id, userId: admin.id, role: 'admin' },
      { workspaceId: workspace.id, userId: member.id, role: 'member' },
      { workspaceId: workspace.id, userId: unverifiedAdmin.id, role: 'admin' },
    ],
  })
  assert.ok(otherWsAdmin.workspace.id !== workspace.id)

  const sent: string[] = []
  const n = await emailWorkspaceAdmins(workspace.id, report('acme.test', ['spf_missing']),
    [{ code: 'spf_missing', severity: 'critical', message: 'No SPF record.' }],
    { mailConfigured: () => true, send: (async (to: string) => { sent.push(to); return {} }) as never })
  assert.equal(n, 2)
  assert.deepEqual(sent.sort(), ['admin@acme.test', 'owner@acme.test'])
})
