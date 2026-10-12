/** Privacy-conscious accumulator for operator jurisdiction inventory. Pure and testable. */
export function parseRolloutDays(argv) {
  const values = argv.filter((a) => a.startsWith('--days='))
  if (values.length > 1) throw new Error('Specify --days only once')
  const raw = values[0]?.slice('--days='.length) ?? '90'
  if (!/^[0-9]+$/.test(raw)) throw new Error('--days must be an integer from 1 to 365')
  const days = Number(raw)
  if (!Number.isSafeInteger(days) || days < 1 || days > 365) throw new Error('--days must be an integer from 1 to 365')
  return days
}

export function summarizeSentRecord(byWorkspace, workspaceId, email) {
  const domain = String(email ?? '').trim().split('@')[1]?.toLowerCase() ?? ''
  const isAu = domain.endsWith('.au')
  const current = byWorkspace.get(workspaceId) ?? { sent: 0, au: 0 }
  current.sent++
  if (isAu) current.au++
  byWorkspace.set(workspaceId, current)
}

export function classifyRolloutExposure(byWorkspace, flaggedIds) {
  const sendingWorkspaces = [...byWorkspace.entries()]
  const auRecipientWorkspaces = sendingWorkspaces.filter(([, counts]) => counts.au > 0)
  const unflaggedWithAu = auRecipientWorkspaces.filter(([id]) => !flaggedIds.has(id))
  return {
    sendingWorkspaces: sendingWorkspaces.length,
    workspacesWithAuTldRecipients: auRecipientWorkspaces.length,
    unflaggedWorkspacesWithAuTldRecipients: unflaggedWithAu.length,
    messages: sendingWorkspaces.reduce((n, [, counts]) => n + counts.sent, 0),
    messagesToAuTld: sendingWorkspaces.reduce((n, [, counts]) => n + counts.au, 0),
    unflaggedAuSenderWorkspaceIds: unflaggedWithAu.map(([id, counts]) => ({ id, sent: counts.sent, toAuTld: counts.au })),
  }
}
