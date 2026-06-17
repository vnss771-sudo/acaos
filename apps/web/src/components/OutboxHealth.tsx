import React, { useEffect, useState, useCallback } from 'react'
import { s, colors } from '../styles.js'
import type { ApiHook } from '../hooks/useApi.js'

type OutboxRow = { id: string; toEmail: string; subject: string; status: string; lastError: string | null; sentAt: string; campaignId: string | null }
type OutboxIssues = { failed: OutboxRow[]; stuck: OutboxRow[]; failedCount: number; stuckCount: number; stuckMinutes: number; hasIssues: boolean }

type Props = { api: ApiHook; workspaceId: string }

// Delivery health: surfaces sends that need attention — FAILED (with the SMTP
// error) and SENDING stuck past the threshold ("unknown delivery"). Renders
// nothing when there are no issues, so a healthy outbox stays out of the way.
export function OutboxHealth({ api, workspaceId }: Props) {
  const [data, setData] = useState<OutboxIssues | null>(null)

  const load = useCallback(() => {
    api<OutboxIssues>(`/api/campaigns/outbox-issues?workspaceId=${workspaceId}`)
      .then(setData)
      .catch(() => {})
  }, [api, workspaceId])

  useEffect(() => { load() }, [load])

  if (!data || !data.hasIssues) return null

  const row = (r: OutboxRow, kind: 'failed' | 'stuck') => (
    <div key={r.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 0', borderTop: `1px solid ${colors.border ?? '#1e2d40'}` }}>
      <span style={{ color: kind === 'failed' ? colors.red : colors.amber, fontWeight: 700, fontSize: 13 }}>
        {kind === 'failed' ? '✕' : '◴'}
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ color: colors.text, fontSize: 13, fontWeight: 600 }}>{r.toEmail}</div>
        <div style={{ color: colors.textFaint, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {kind === 'failed'
            ? (r.lastError || 'Send failed (no error detail)')
            : `Claimed ${new Date(r.sentAt).toLocaleString()} — never confirmed delivered`}
        </div>
      </div>
    </div>
  )

  return (
    <div style={{ ...s.card, borderColor: colors.red + '55' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <div style={s.sectionHeader}>Delivery needs attention</div>
        <span style={{ color: colors.textFaint, fontSize: 12 }}>
          {data.failedCount} failed · {data.stuckCount} stuck
        </span>
      </div>
      <div style={{ color: colors.textMuted, fontSize: 13, marginBottom: 8 }}>
        These sends didn't complete cleanly. Failed sends are not auto-retried — review and resend deliberately.
      </div>
      {data.failed.map((r) => row(r, 'failed'))}
      {data.stuck.map((r) => row(r, 'stuck'))}
      {(data.failedCount > data.failed.length || data.stuckCount > data.stuck.length) && (
        <div style={{ color: colors.textFaint, fontSize: 12, marginTop: 8 }}>
          Showing the most recent — {data.failedCount + data.stuckCount} total.
        </div>
      )}
    </div>
  )
}
