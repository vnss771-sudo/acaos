#!/usr/bin/env node
/**
 * READ-ONLY report for the targetsAustralia rollout decision. Prints aggregate counts and
 * workspace IDs only — never recipient addresses, workspace names or any content. Writes nothing.
 * Run it yourself against the database you want to assess (uses DATABASE_URL).
 *
 *   DATABASE_URL=... NODE_OPTIONS=--conditions=acaos-src node scripts/report-au-rollout.mjs [--json] [--days=90]
 */
import { PrismaClient } from '@prisma/client'
import { parseRolloutDays, summarizeSentRecord, classifyRolloutExposure } from './lib-au-rollout.mjs'

const days = parseRolloutDays(process.argv.slice(2))
const asJson = process.argv.includes('--json')
const prisma = new PrismaClient({ log: ['error'] })
const since = new Date(Date.now() - days * 86_400_000)

try {
  const [total, flagged, canada] = await Promise.all([
    prisma.workspace.count(),
    prisma.workspace.count({ where: { targetsAustralia: true } }),
    prisma.workspace.count({ where: { targetsCanada: true } }),
  ])

  // Read only: bounded keyset pagination. Do not materialize every recipient email
  // into memory or log raw addresses. The .au TLD is a signal, NOT a legal ruling.
  const byWs = new Map()
  const pageSize = 500
  let cursor
  while (true) {
    const page = await prisma.outreachSent.findMany({
      where: { sentAt: { gte: since } },
      select: { id: true, workspaceId: true, toEmail: true },
      orderBy: { id: 'asc' },
      take: pageSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })
    for (const r of page) summarizeSentRecord(byWs, r.workspaceId, r.toEmail)
    if (page.length < pageSize) break
    cursor = page.at(-1).id
  }
  const flaggedIds = new Set((await prisma.workspace.findMany({ where: { targetsAustralia: true }, select: { id: true } })).map((w) => w.id))
  const exposure = classifyRolloutExposure(byWs, flaggedIds)

  const consentByBasis = await prisma.consentRecord.groupBy({ by: ['basis'], _count: { _all: true } })

  const report = {
    generatedAt: new Date().toISOString(),
    windowDays: days,
    workspaces: { total, targetsAustralia: flagged, targetsCanada: canada },
    sendingInWindow: {
      workspaces: exposure.sendingWorkspaces,
      workspacesWithAuTldRecipients: exposure.workspacesWithAuTldRecipients,
      unflaggedWorkspacesWithAuTldRecipients: exposure.unflaggedWorkspacesWithAuTldRecipients,
      messages: exposure.messages,
      messagesToAuTld: exposure.messagesToAuTld,
    },
    unflaggedAuSenderWorkspaceIds: exposure.unflaggedAuSenderWorkspaceIds,
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
