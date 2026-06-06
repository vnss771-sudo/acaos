import React, { useEffect, useState } from 'react'
import type { Workspace, StatsData, View, ScoringModel } from '../types.js'
import { STAGE_COLOR, TIER_COLOR } from '../types.js'
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

function StatCard({
  label, value, sub, color = colors.text, trend
}: {
  label: string; value: string | number; sub?: string; color?: string; trend?: string
}) {
  return (
    <div style={s.card}>
      <div style={{ color: colors.textFaint, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>
        {label}
      </div>
      <div style={{ color, fontSize: 30, fontWeight: 700, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ color: colors.textFaint, fontSize: 12, marginTop: 6 }}>{sub}</div>}
      {trend && <div style={{ color: colors.green, fontSize: 11, marginTop: 4 }}>{trend}</div>}
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

function UsageMeter({ used, limit, plan }: { used: number; limit: number; plan: string }) {
  const unlimited = limit === -1
  const pct = unlimited ? 0 : Math.min(100, (used / limit) * 100)
  const warning = !unlimited && pct >= 80
  const barColor = warning ? colors.amber : colors.blue

  return (
    <div style={s.cardInner}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ color: colors.textFaint, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          AI Calls This Month
        </span>
        <span style={{ fontSize: 11, color: warning ? colors.amber : colors.textFaint }}>
          {unlimited ? `${used} / ∞` : `${used} / ${limit}`}
        </span>
      </div>
      {!unlimited && (
        <div style={{ background: '#1e2d40', borderRadius: 4, height: 5, overflow: 'hidden' }}>
          <div style={{
            width: `${pct}%`, height: '100%', background: barColor,
            borderRadius: 4, transition: 'width 0.3s'
          }} />
        </div>
      )}
      <div style={{ color: colors.textFaint, fontSize: 11, marginTop: 4 }}>
        {unlimited ? `Unlimited on ${plan} plan` : warning ? `${Math.round(limit - used)} calls remaining — consider upgrading` : `${plan} plan`}
      </div>
    </div>
  )
}

function WeightBar({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = max > 0 ? (value / max) * 100 : 0
  const displayPct = Math.round(value * 100)
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
        <span style={{ color: colors.textMuted, fontSize: 12, textTransform: 'capitalize' }}>{label.replace(/([A-Z])/g, ' $1')}</span>
        <span style={{ color: colors.text, fontSize: 12, fontWeight: 600 }}>{displayPct}%</span>
      </div>
      <div style={{ background: '#1e2d40', borderRadius: 3, height: 4, overflow: 'hidden' }}>
        <div style={{
          width: `${pct}%`, height: '100%',
          background: `linear-gradient(90deg, ${colors.blue}, ${colors.purple})`,
          borderRadius: 3, transition: 'width 0.4s ease'
        }} />
      </div>
    </div>
  )
}

function ScoringModelCard({ model }: { model: ScoringModel }) {
  const weights = model.weights as Record<string, number>
  const maxWeight = Math.max(...Object.values(weights))
  const sortedWeights = Object.entries(weights)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 6) // top 6

  const m = model.metrics
  const correlation = m.correlationScore

  return (
    <div style={s.card}>
      <div style={{ ...s.flexBetween, marginBottom: 12 }}>
        <div style={s.sectionHeader}>Scoring Model</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: colors.textFaint }}>{model.updateCount} updates</span>
          {model.lastWeightUpdate && (
            <span style={{ fontSize: 11, color: colors.textFaint }}>
              · last {new Date(model.lastWeightUpdate).toLocaleDateString()}
            </span>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div>
          <div style={{ color: colors.textFaint, fontSize: 11, marginBottom: 8, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Active Weights
          </div>
          {sortedWeights.map(([key, val]) => (
            <WeightBar key={key} label={key} value={val} max={maxWeight} />
          ))}
        </div>

        <div style={{ display: 'grid', gap: 8, alignContent: 'start' }}>
          <div style={s.cardInner}>
            <div style={{ color: colors.textFaint, fontSize: 11, marginBottom: 4 }}>Reply Rate</div>
            <div style={{ color: colors.green, fontSize: 22, fontWeight: 700 }}>
              {m.totalScored > 0 ? `${Math.round(m.replyRate * 100)}%` : '–'}
            </div>
            <div style={{ color: colors.textFaint, fontSize: 11 }}>{m.totalReplied} / {m.totalScored} outcomes</div>
          </div>
          <div style={s.cardInner}>
            <div style={{ color: colors.textFaint, fontSize: 11, marginBottom: 4 }}>Score Correlation</div>
            <div style={{
              fontSize: 22, fontWeight: 700,
              color: correlation > 0.5 ? colors.green : correlation > 0.2 ? colors.amber : colors.red
            }}>
              {m.totalScored > 0 ? correlation.toFixed(2) : '–'}
            </div>
            <div style={{ color: colors.textFaint, fontSize: 11 }}>
              {correlation > 0.5 ? 'Strong signal' : correlation > 0.2 ? 'Moderate signal' : m.totalScored > 0 ? 'Weak signal' : 'Needs more data'}
            </div>
          </div>
          <div style={s.cardInner}>
            <div style={{ color: colors.textFaint, fontSize: 11, marginBottom: 4 }}>Avg Score — Replied</div>
            <div style={{ color: colors.amber, fontSize: 22, fontWeight: 700 }}>
              {m.totalReplied > 0 ? Math.round(m.avgScoreOfReplied) : '–'}
            </div>
            <div style={{ color: colors.textFaint, fontSize: 11 }}>
              {m.totalScored - m.totalReplied > 0 ? `vs ${Math.round(m.avgScoreOfNotReplied)} not replied` : ''}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function TierDistribution({ dist }: { dist: { HOT: number; WARM: number; COLD: number } }) {
  const total = dist.HOT + dist.WARM + dist.COLD
  if (total === 0) return null

  return (
    <div style={{ display: 'flex', gap: 8 }}>
      {(['HOT', 'WARM', 'COLD'] as const).map(tier => (
        <div key={tier} style={{
          flex: 1, background: TIER_COLOR[tier] + '22',
          border: `1px solid ${TIER_COLOR[tier]}44`,
          borderRadius: 8, padding: '10px 14px', textAlign: 'center'
        }}>
          <div style={{ color: TIER_COLOR[tier], fontWeight: 700, fontSize: 20 }}>{dist[tier]}</div>
          <div style={{ color: TIER_COLOR[tier], fontSize: 11, fontWeight: 600 }}>{tier}</div>
          <div style={{ color: colors.textFaint, fontSize: 11 }}>{total > 0 ? Math.round((dist[tier] / total) * 100) : 0}%</div>
        </div>
      ))}
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
      {/* KPI row */}
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

      {/* Score tier distribution */}
      {!loading && stats?.scoreDistribution && (
        <div style={s.card}>
          <div style={{ ...s.flexBetween, marginBottom: 12 }}>
            <div style={s.sectionHeader}>Lead Tier Distribution</div>
            <button style={s.btnSm} onClick={() => setView('leads')}>View leads →</button>
          </div>
          <TierDistribution dist={stats.scoreDistribution} />
        </div>
      )}

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

        {/* Recent leads + usage */}
        <div style={{ display: 'grid', gap: 16 }}>
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
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      {lead.score > 0 && (
                        <span style={{ fontSize: 12, fontWeight: 700, color: colors.amber }}>{lead.score}</span>
                      )}
                      <span style={s.badge(STAGE_COLOR[lead.stage] || colors.textFaint)}>{lead.stage}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState message="No leads yet — add your first lead" icon="◎" />
            )}
          </div>

          {/* AI Usage */}
          {!loading && stats?.usage && (
            <div style={s.card}>
              <div style={s.sectionHeader}>AI Usage</div>
              <UsageMeter
                used={stats.usage.total}
                limit={stats.usage.limit}
                plan={stats.usage.plan}
              />
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginTop: 10 }}>
                {[
                  { label: 'Research', key: 'AI_RESEARCH' as const, icon: '✦' },
                  { label: 'Outreach', key: 'AI_OUTREACH' as const, icon: '✉' },
                  { label: 'Replies', key: 'AI_REPLY' as const, icon: '◎' }
                ].map(({ label, key, icon }) => (
                  <div key={key} style={{ textAlign: 'center' }}>
                    <div style={{ color: colors.textFaint, fontSize: 11 }}>{icon} {label}</div>
                    <div style={{ color: colors.text, fontWeight: 700, fontSize: 16 }}>
                      {stats.usage.totals[key]}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Scoring model */}
      {!loading && stats?.scoringModel && (
        <ScoringModelCard model={stats.scoringModel} />
      )}

      {/* Top scoring leads */}
      {stats?.topLeads && stats.topLeads.length > 0 && (
        <div style={s.card}>
          <div style={s.sectionHeader}>Top Scoring Leads</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['Business', 'Category', 'Tier', 'Stage', 'Score'].map(h => (
                  <th key={h} style={{ ...s.sectionHeader, padding: '0 12px 8px 0', textAlign: 'left' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {stats.topLeads.map(lead => {
                const tier = lead.score >= 72 ? 'HOT' : lead.score >= 48 ? 'WARM' : 'COLD'
                return (
                  <tr key={lead.id}>
                    <td style={{ padding: '8px 12px 8px 0', color: colors.text, fontSize: 14 }}>{lead.businessName}</td>
                    <td style={{ padding: '8px 12px 8px 0', color: colors.textFaint, fontSize: 13 }}>{lead.category || '–'}</td>
                    <td style={{ padding: '8px 12px 8px 0' }}>
                      <span style={s.badge(TIER_COLOR[tier])}>{tier}</span>
                    </td>
                    <td style={{ padding: '8px 12px 8px 0' }}>
                      <span style={s.badge(STAGE_COLOR[lead.stage] || colors.textFaint)}>{lead.stage}</span>
                    </td>
                    <td style={{ padding: '8px 12px 8px 0', color: colors.amber, fontSize: 14, fontWeight: 700 }}>{lead.score}</td>
                  </tr>
                )
              })}
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
            onMouseEnter={e => {
              (e.currentTarget as HTMLElement).style.borderColor = colors.blue
              ;(e.currentTarget as HTMLElement).style.color = colors.text
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLElement).style.borderColor = colors.border
              ;(e.currentTarget as HTMLElement).style.color = colors.textMuted
            }}
          >
            <span style={{ fontSize: 18, color: colors.blue }}>{icon}</span>
            {label}
          </button>
        ))}
      </div>
    </div>
  )
}
