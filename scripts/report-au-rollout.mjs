#!/usr/bin/env node
/**
 * READ-ONLY report for the targetsAustralia rollout decision. Prints aggregate counts and
 * workspace IDs only — never recipient addresses, workspace names or any content. Writes nothing.
 * Run it yourself against the database you want to assess (uses DATABASE_URL).
 *
 *   DATABASE_URL=... NODE_OPTIONS=--conditions=acaos-src node scripts/report-au-rollout.mjs [--json] [--days=90]
 */
import { PrismaClient } from '@prisma/client'

const days = Number((process.argv.find((a) => a.startsWith('--days=')) ?? '--days=90').slice(7)) || 90
const asJson = process.argv.includes('--json')
const prisma = new PrismaClient({ log: ['error'] })
const since = new Date(Date.now() - days * 86_400_000)

try {
  const [total, flagged, canada] = await Promise.all([
    prisma.workspace.count(),
    prisma.workspace.count({ where: { targetsAustralia: true } }),
    prisma.workspace.count({ where: { targetsCanada: true } }),
  ])

  // Recipient jurisdiction signal from what was actually sent (TLD only; the address itself is never output).
  const sent = await prisma.outreachSent.findMany({
    where: { sentAt: { gte: since } },
    select: { workspaceId: true, toEmail: true },
  })
  const byWs = new Map()
  for (const r of sent) {
    const host = String(r.toEmail ?? '').split('@')[1]?.toLowerCase() ?? ''
    const isAu = host.endsWith('.au')
    const w = byWs.get(r.workspaceId) ?? { sent: 0, au: 0 }
    w.sent += 1; if (isAu) w.au += 1
    byWs.set(r.workspaceId, w)
  }
  const flaggedIds = new Set((await prisma.workspace.findMany({ where: { targetsAustralia: true }, select: { id: true } })).map((w) => w.id))
  const sendingWorkspaces = [...byWs.entries()]
  const auRecipientWorkspaces = sendingWorkspaces.filter(([, v]) => v.au > 0)
  const unflaggedWithAu = auRecipientWorkspaces.filter(([id]) => !flaggedIds.has(id))

  const consentByBasis = await prisma.consentRecord.groupBy({ by: ['basis'], _count: { _all: true } })

  const report = {
    generatedAt: new Date().toISOString(),
    windowDays: days,
    workspaces: { total, targetsAustralia: flagged, targetsCanada: canada },
    sendingInWindow: {
      workspaces: sendingWorkspaces.length,
      workspacesWithAuTldRecipients: auRecipientWorkspaces.length,
      unflaggedWorkspacesWithAuTldRecipients: unflaggedWithAu.length,
      messages: sent.length,
      messagesToAuTld: sendingWorkspaces.reduce((n, [, v]) => n + v.au, 0),
    },
    // IDs only. These are the workspaces that send to .au recipients today but are NOT covered by the D2 gate.
    unflaggedAuSenderWorkspaceIds: unflaggedWithAu.map(([id, v]) => ({ id, sent: v.sent, toAuTld: v.au })),
    consentRecordsByBasis: Object.fromEntries(consentByBasis.map((g) => [g.basis, g._count._all])),
    note: 'TLD ".au" is a heuristic for an Australian link (Spam Act s7 also covers other connections). No addresses or names are printed.',
  }
  if (asJson) console.log(JSON.stringify(report, null, 2))
  else {
    console.log(`Workspaces: ${total} total · ${flagged} flagged targetsAustralia · ${canada} flagged targetsCanada`)
    console.log(`Last ${days} days: ${report.sendingInWindow.workspaces} workspaces sent ${report.sendingInWindow.messages} messages; ${report.sendingInWindow.messagesToAuTld} to .au recipients`)
    console.log(`Workspaces sending to .au recipients: ${report.sendingInWindow.workspacesWithAuTldRecipients} (${report.sendingInWindow.unflaggedWorkspacesWithAuTldRecipients} NOT flagged → not covered by the D2 gate)`)
    for (const w of report.unflaggedAuSenderWorkspaceIds) console.log(`  workspace=${w.id} sent=${w.sent} toAu=${w.toAuTld}`)
    console.log('Consent records by basis:', JSON.stringify(report.consentRecordsByBasis))
  }
} finally {
  await prisma.$disconnect()
}
