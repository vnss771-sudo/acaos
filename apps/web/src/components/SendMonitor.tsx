import React, { useEffect, useState } from 'react'
import type { View } from '../types.js'
import { s, colors } from '../styles.js'
import { Card } from './ui/Card.js'
import { Grid } from './ui/Grid.js'
import type { ApiHook } from '../hooks/useApi.js'

type Summary = {
  total: number
  delivered: number
  sent: number
  replied: number
  bounced: number
  failed: number
  sending: number
  last24hSent: number
  replyRate: number
}

// Radar Send Monitor: workspace-level outreach delivery health so live sending
// isn't invisible. Self-contained and hides itself when no outreach has been sent
// (matches the GettingStarted/OutboxHealth dashboard-widget pattern).
export function SendMonitor({ api, workspaceId, setView }: { api: ApiHook; workspaceId: string; setView: (v: View) => void }) {
  const [data, setData] = useState<Summary | null>(null)

  useEffect(() => {
    let cancelled = false
    api<Summary>(`/api/sends/summary?workspaceId=${workspaceId}`)
      .then(d => { if (!cancelled) setData(d) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [api, workspaceId])

  if (!data || data.total === 0) return null

  const issues = data.bounced + data.failed
  return (
    <Card style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ ...s.flexBetween }}>
        <div style={s.sectionHeader}>Outreach Activity</div>
        {data.sending > 0 && (
          <span style={{ fontSize: 11, color: colors.blueLight, fontWeight: 700, background: colors.blue + '22', padding: '2px 8px', borderRadius: 12 }}>
            {data.sending} sending…
          </span>
        )}
      </div>
      <Grid cols={4} gap={12}>
        <Stat label="Delivered" value={data.delivered} color={colors.text} />
        <Stat label="Reply rate" value={`${data.replyRate}%`} color={colors.green} />
        <Stat label="Sent (24h)" value={data.last24hSent} color={colors.blueLight} />
        <Stat label="Bounced / failed" value={issues} color={issues > 0 ? colors.red : colors.textFaint} />
      </Grid>
      {issues > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: colors.textMuted }}>
          <span style={{ color: colors.red }}>⚠ {issues} delivery issue{issues === 1 ? '' : 's'}</span>
          <button style={s.btnSm} onClick={() => setView('campaigns')}>Review delivery →</button>
        </div>
      )}
    </Card>
  )
}

function Stat({ label, value, color }: { label: string; value: React.ReactNode; color: string }) {
  return (
    <div style={s.cardInner}>
      <div style={{ color: colors.textFaint, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
      <div style={{ color, fontSize: 22, fontWeight: 700 }}>{value}</div>
    </div>
  )
}
