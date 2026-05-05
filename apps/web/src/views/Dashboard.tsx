import React, { useEffect, useState } from 'react'
import type { Workspace, StatsData, View } from '../types.js'
import { STAGE_COLOR } from '../types.js'
import { s, colors } from '../styles.js'
import { Spinner, EmptyState } from '../components/Spinner.js'
import type { ApiHook } from '../hooks/useApi.js'
import type { ToastHook } from '../hooks/useToast.js'

type Props = {
  api: ApiHook
  workspace: Workspace | null
  setView: (v: View) => void
  toast: ToastHook
}

function StatCard({ label, value, sub, color = colors.text }: { label: string; value: string | number; sub?: string; color?: string }) {
  return (
    <div style={s.card}>
      <div style={{ color: colors.textFaint, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>{label}</div>
      <div style={{ color, fontSize: 30, fontWeight: 700, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ color: colors.textFaint, fontSize: 12, marginTop: 6 }}>{sub}</div>}
    </div>
  )
}

function FunnelBar({ stage, count, max }: { stage: string; count: number; max: number }) {
  const pct = max > 0 ? (count / max) * 100 : 0
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ color: colors.textMuted, fontSize: 13 }}>{stage}</span>
        <span style={{ color: colors.text, fontSize: 13, fontWeight: 600 }}>{count}</span>
      </div>
      <div style={{ background: '#1e2d40', borderRadius: 4, height: 6, overflow: 'hidden' }}>
        <div style={{
          width: `${pct}%`, height: '100%',
          background: STAGE_COLOR[stage] || colors.textFaint,
          borderRadius: 4, transition: 'width 0.4s ease'
        }} />
      </div>
    </div>
  )
}

export function Dashboard({ api, workspace, setView, toast }: Props) {
  const [stats, setStats] = useState<StatsData | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!workspace) return
    setLoading(true)
    api<StatsData>(`/api/stats?workspaceId=${workspace.id}`)
      .then(setStats)
      .catch(e => toast.error(e.message))
      .finally(() => setLoading(false))
  }, [workspace?.id])

  if (!workspace) {
    return (
      <div style={s.card}>
        <EmptyState message="No workspace selected" icon="◈" />
      </div>
    )
  }

  const STAGES_ORDER = ['NEW', 'RESEARCHED', 'OUTREACH_SENT', 'REPLIED', 'BOOKED', 'CLOSED', 'DEAD']
  const maxCount = stats ? Math.max(...STAGES_ORDER.map(s => stats.funnel[s] ?? 0), 1) : 1

  return (
    <div style={s.stack}>
      {/* Top metrics */}
      <div style={s.grid4}>
        <StatCard label="Total Leads" value={loading ? '…' : (stats?.totalLeads ?? 0)} color={colors.blueLight} />
        <StatCard label="Campaigns" value={loading ? '…' : (stats?.campaignCount ?? 0)} />
        <StatCard
          label="Reply Rate"
          value={loading ? '…' : `${stats?.metrics.replyRate ?? 0}%`}
          sub={`${stats?.metrics.replied ?? 0} of ${stats?.metrics.contacted ?? 0} contacted`}
          color={colors.green}
        />
        <StatCard
          label="Booked"
          value={loading ? '…' : (stats?.metrics.booked ?? 0)}
          sub={`${stats?.metrics.bookingRate ?? 0}% booking rate`}
          color={colors.amber}
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {/* Funnel */}
        <div style={s.card}>
          <div style={s.sectionHeader}>Pipeline Funnel</div>
          {loading ? (
            <div style={{ textAlign: 'center', padding: 24 }}><Spinner /></div>
          ) : stats ? (
            STAGES_ORDER.map(stage => (
              <FunnelBar key={stage} stage={stage} count={stats.funnel[stage] ?? 0} max={maxCount} />
            ))
          ) : (
            <EmptyState message="No data yet" icon="◎" />
          )}
        </div>

        {/* Recent leads */}
        <div style={s.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <div style={s.sectionHeader}>Recent Leads</div>
            <button style={s.btnSm} onClick={() => setView('leads')}>View all →</button>
          </div>
          {loading ? (
            <div style={{ textAlign: 'center', padding: 24 }}><Spinner /></div>
          ) : stats?.recentLeads.length ? (
            <div style={{ display: 'grid', gap: 8 }}>
              {stats.recentLeads.map(lead => (
                <div key={lead.id} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '8px 0', borderBottom: `1px solid ${colors.borderLight}`
                }}>
                  <div>
                    <div style={{ color: colors.text, fontSize: 14 }}>{lead.businessName}</div>
                    <div style={{ color: colors.textFaint, fontSize: 12 }}>{lead.category || 'Uncategorized'}</div>
                  </div>
                  <span style={s.badge(STAGE_COLOR[lead.stage] || colors.textFaint)}>{lead.stage}</span>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState message="No leads yet — add your first lead" icon="◎" />
          )}
        </div>
      </div>

      {/* Top scoring leads */}
      {stats?.topLeads && stats.topLeads.length > 0 && (
        <div style={s.card}>
          <div style={s.sectionHeader}>Top Scoring Leads</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['Business', 'Category', 'Stage', 'Score'].map(h => (
                  <th key={h} style={{ ...s.sectionHeader, padding: '0 12px 8px 0', textAlign: 'left' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {stats.topLeads.map(lead => (
                <tr key={lead.id}>
                  <td style={{ padding: '8px 12px 8px 0', color: colors.text, fontSize: 14 }}>{lead.businessName}</td>
                  <td style={{ padding: '8px 12px 8px 0', color: colors.textFaint, fontSize: 13 }}>{lead.category || '–'}</td>
                  <td style={{ padding: '8px 12px 8px 0' }}>
                    <span style={s.badge(STAGE_COLOR[lead.stage] || colors.textFaint)}>{lead.stage}</span>
                  </td>
                  <td style={{ padding: '8px 12px 8px 0', color: colors.amber, fontSize: 14, fontWeight: 700 }}>{lead.score}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Quick actions */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
        {[
          { label: 'Add Lead', icon: '+', action: () => setView('leads') },
          { label: 'New Campaign', icon: '◈', action: () => setView('campaigns') },
          { label: 'Run AI Research', icon: '✦', action: () => setView('ai') }
        ].map(({ label, icon, action }) => (
          <button
            key={label}
            onClick={action}
            style={{
              ...s.card, border: `1px solid ${colors.border}`,
              cursor: 'pointer', background: 'transparent',
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '16px 20px', textAlign: 'left',
              color: colors.textMuted, fontSize: 14,
              transition: 'border-color 0.15s, background 0.15s'
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = colors.blue; (e.currentTarget as HTMLElement).style.color = colors.text }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = colors.border; (e.currentTarget as HTMLElement).style.color = colors.textMuted }}
          >
            <span style={{ fontSize: 18, color: colors.blue }}>{icon}</span>
            {label}
          </button>
        ))}
      </div>
    </div>
  )
}
