import React, { useEffect, useState } from 'react'
import type { Workspace, StatsData, View, ScoringModel, Signal, Prospect } from '../types.js'
import { STAGE_COLOR, TIER_COLOR, SIGNAL_TYPE_ICONS, SIGNAL_TYPE_LABELS } from '../types.js'
import { s, colors } from '../styles.js'
import { Spinner, EmptyState } from '../components/Spinner.js'
import { GettingStarted } from '../components/GettingStarted.js'
import { NextBestActionCard } from '../components/NextBestAction.js'
import { OutboxHealth } from '../components/OutboxHealth.js'
import { OutreachIntents } from '../components/OutreachIntents.js'
import { Card } from '../components/ui/Card.js'
import { KpiCard } from '../components/ui/KpiCard.js'
import { ProgressBar } from '../components/ui/ProgressBar.js'
import { Grid } from '../components/ui/Grid.js'
import { Badge } from '../components/ui/Badge.js'
import { Table, type Column } from '../components/ui/Table.js'
import type { ApiHook } from '../hooks/useApi.js'
import type { ToastHook } from '../hooks/useToast.js'

type Props = {
  api: ApiHook
  workspace: Workspace | null
  setView: (v: View) => void
  toast: ToastHook
}

type TopLead = NonNullable<StatsData['topLeads']>[number]

function FunnelBar({ stage, count, max }: { stage: string; count: number; max: number }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ color: colors.textMuted, fontSize: 13 }}>{stage}</span>
        <span style={{ color: colors.text, fontSize: 13, fontWeight: 600 }}>{count}</span>
      </div>
      <ProgressBar value={count} max={max} color={STAGE_COLOR[stage] || colors.textFaint} height={6} track="#1e2d40" />
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
        <ProgressBar value={used} max={limit} color={barColor} height={5} track="#1e2d40" />
      )}
      <div style={{ color: colors.textFaint, fontSize: 11, marginTop: 4 }}>
        {unlimited ? `Unlimited on ${plan} plan` : warning ? `${Math.round(limit - used)} calls remaining — consider upgrading` : `${plan} plan`}
      </div>
    </div>
  )
}

function WeightBar({ label, value, max }: { label: string; value: number; max: number }) {
  const displayPct = Math.round(value * 100)
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
        <span style={{ color: colors.textMuted, fontSize: 12, textTransform: 'capitalize' }}>{label.replace(/([A-Z])/g, ' $1')}</span>
        <span style={{ color: colors.text, fontSize: 12, fontWeight: 600 }}>{displayPct}%</span>
      </div>
      <ProgressBar value={value} max={max} gradient={`linear-gradient(90deg, ${colors.blue}, ${colors.purple})`} height={4} track="#1e2d40" />
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

type RecentSignal = Signal & { prospect?: { id: string; companyName: string } }

function HotAccountsSection({ hotProspects, setView }: { hotProspects: Prospect[]; setView: (v: View) => void }) {
  if (hotProspects.length === 0) return null
  return (
    <div style={s.card}>
      <div style={{ ...s.flexBetween, marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={s.sectionHeader}>Hot Accounts Today</div>
          <span style={{ fontSize: 11, color: '#ef4444', fontWeight: 700, background: '#ef444418', padding: '2px 8px', borderRadius: 12 }}>
            {hotProspects.length} HOT
          </span>
        </div>
        <button style={s.btnSm} onClick={() => setView('intelligence')}>Full radar →</button>
      </div>
      <div style={{ display: 'grid', gap: 10 }}>
        {hotProspects.slice(0, 5).map(p => (
          <div key={p.id} style={{
            padding: '12px 14px', background: '#ef444408', borderRadius: 8,
            border: '1px solid #ef444430', display: 'flex', gap: 14, alignItems: 'flex-start'
          }}>
            <div style={{
              width: 44, height: 44, borderRadius: '50%', flexShrink: 0,
              background: '#ef444422', border: '2px solid #ef4444',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 15, fontWeight: 800, color: '#ef4444'
            }}>
              {p.opportunityScore}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: colors.text, fontWeight: 600, fontSize: 14 }}>{p.companyName}</div>
              <div style={{ color: colors.textFaint, fontSize: 12 }}>
                {p.industry || 'Unknown industry'}{p.location ? ` · ${p.location}` : ''}
              </div>
              {p.latestSignal && (
                <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 13 }}>{SIGNAL_TYPE_ICONS[p.latestSignal.type]}</span>
                  <span style={{ color: '#ef4444', fontSize: 12, fontWeight: 500 }}>
                    {SIGNAL_TYPE_LABELS[p.latestSignal.type]}
                  </span>
                  {p.latestSignal.title && (
                    <span style={{ color: colors.textFaint, fontSize: 12 }}>— {p.latestSignal.title}</span>
                  )}
                </div>
              )}
              {p.topRecommendation?.actionText && (
                <div style={{ marginTop: 4, color: colors.amber, fontSize: 12 }}>
                  Recommended: {p.topRecommendation.actionText}
                </div>
              )}
            </div>
            {p.winProbability != null && (
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div style={{ color: colors.green, fontWeight: 700, fontSize: 16 }}>{Math.round(p.winProbability * 100)}%</div>
                <div style={{ color: colors.textFaint, fontSize: 11 }}>win prob</div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function SignalFeedSection({ signals }: { signals: RecentSignal[] }) {
  if (signals.length === 0) return null
  return (
    <div style={s.card}>
      <div style={{ ...s.sectionHeader, marginBottom: 12 }}>Signal Feed</div>
      <div style={{ display: 'grid', gap: 8 }}>
        {signals.map(sig => {
          const age = Math.floor((Date.now() - new Date(sig.detectedAt).getTime()) / (1000 * 60 * 60))
          const ageLabel = age < 1 ? 'just now' : age < 24 ? `${age}h ago` : `${Math.floor(age / 24)}d ago`
          const strengthColor = sig.strength >= 70 ? colors.green : sig.strength >= 40 ? colors.amber : colors.textFaint
          return (
            <div key={sig.id} style={{
              display: 'flex', gap: 10, alignItems: 'flex-start',
              padding: '8px 0', borderBottom: `1px solid ${colors.border}`
            }}>
              <span style={{ fontSize: 16, flexShrink: 0, marginTop: 1 }}>{SIGNAL_TYPE_ICONS[sig.type]}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ color: colors.text, fontSize: 13, fontWeight: 500 }}>
                    {sig.prospect?.companyName ?? 'Unknown'}
                  </span>
                  <span style={{ color: colors.textFaint, fontSize: 12 }}>{SIGNAL_TYPE_LABELS[sig.type]}</span>
                </div>
                {sig.title && <div style={{ color: colors.textFaint, fontSize: 12, marginTop: 2 }}>{sig.title}</div>}
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div style={{ color: strengthColor, fontWeight: 700, fontSize: 13 }}>{sig.strength}</div>
                <div style={{ color: colors.textFaint, fontSize: 11 }}>{ageLabel}</div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function Dashboard({ api, workspace, setView, toast }: Props) {
  const [stats, setStats] = useState<StatsData | null>(null)
  const [loading, setLoading] = useState(false)
  const [hotProspects, setHotProspects] = useState<Prospect[]>([])
  const [recentSignals, setRecentSignals] = useState<RecentSignal[]>([])

  useEffect(() => {
    if (!workspace) return
    // Drop results from a superseded workspace so switching workspaces quickly
    // doesn't render one workspace's stats under another.
    let cancelled = false
    setLoading(true)
    Promise.all([
      api<StatsData>(`/api/stats?workspaceId=${workspace.id}`),
      api<{ hot: Prospect[]; warm: Prospect[]; cold: Prospect[] }>(`/api/intelligence/opportunities?workspaceId=${workspace.id}`)
        .catch(() => ({ hot: [], warm: [], cold: [] })),
      api<{ signals: RecentSignal[] }>(`/api/signals?workspaceId=${workspace.id}&limit=10`)
        .catch(() => ({ signals: [] }))
    ]).then(([statsData, opps, sigData]) => {
      if (cancelled) return
      setStats(statsData)
      setHotProspects(opps.hot ?? [])
      setRecentSignals(sigData.signals ?? [])
    }).catch(e => { if (!cancelled) toast.error(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
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
      {/* Acquisition Radar — the single highest-priority action, above analytics. */}
      {!loading && (
        <NextBestActionCard
          stats={stats}
          hotCount={hotProspects.length}
          signalCount={recentSignals.length}
          setView={setView}
        />
      )}

      {/* Onboarding: shows send-readiness steps; hides itself once ready */}
      <GettingStarted api={api} workspaceId={workspace.id} toast={toast} setView={setView} />

      {/* Delivery health: shows failed/stuck sends; hides itself when clean */}
      <OutboxHealth api={api} workspaceId={workspace.id} />

      {/* This week's outreach: actionable evidence-backed intents; hides when empty */}
      <OutreachIntents api={api} workspaceId={workspace.id} toast={toast} />

      {/* Hot accounts + signal feed — only shown when data exists */}
      {!loading && (hotProspects.length > 0 || recentSignals.length > 0) && (
        <div style={{ display: 'grid', gridTemplateColumns: recentSignals.length > 0 ? '1.4fr 1fr' : '1fr', gap: 16 }}>
          <HotAccountsSection hotProspects={hotProspects} setView={setView} />
          {recentSignals.length > 0 && <SignalFeedSection signals={recentSignals} />}
        </div>
      )}

      {/* KPI row */}
      <Grid cols={4}>
        <KpiCard label="Total Leads" value={loading ? '…' : (stats?.totalLeads ?? 0)} color={colors.blueLight} />
        <KpiCard label="Campaigns" value={loading ? '…' : (stats?.campaignCount ?? 0)} />
        <KpiCard
          label="Reply Rate"
          value={loading ? '…' : `${stats?.metrics.replyRate ?? 0}%`}
          sub={`${stats?.metrics.replied ?? 0} of ${stats?.metrics.contacted ?? 0} contacted`}
          color={colors.green}
        />
        <KpiCard
          label="Booked"
          value={loading ? '…' : (stats?.metrics.booked ?? 0)}
          sub={`${stats?.metrics.bookingRate ?? 0}% booking rate`}
          color={colors.amber}
        />
      </Grid>

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

      <Grid cols={2}>
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
              <Grid cols={3} gap={8} style={{ marginTop: 10 }}>
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
              </Grid>
            </div>
          )}
        </div>
      </Grid>

      {/* Scoring model */}
      {!loading && stats?.scoringModel && (
        <ScoringModelCard model={stats.scoringModel} />
      )}

      {/* Top scoring leads */}
      {stats?.topLeads && stats.topLeads.length > 0 && (
        <Card>
          <div style={s.sectionHeader}>Top Scoring Leads</div>
          <Table<TopLead>
            rows={stats.topLeads}
            rowKey={lead => lead.id}
            columns={[
              { key: 'businessName', header: 'Business', render: lead => lead.businessName },
              { key: 'category', header: 'Category', render: lead => lead.category || '–' },
              {
                key: 'tier', header: 'Tier',
                render: lead => {
                  const tier = lead.score >= 72 ? 'HOT' : lead.score >= 48 ? 'WARM' : 'COLD'
                  return <Badge color={TIER_COLOR[tier]}>{tier}</Badge>
                },
              },
              { key: 'stage', header: 'Stage', render: lead => <Badge color={STAGE_COLOR[lead.stage] || colors.textFaint}>{lead.stage}</Badge> },
              { key: 'score', header: 'Score', align: 'right', render: lead => <span style={{ color: colors.amber, fontWeight: 700 }}>{lead.score}</span> },
            ] as Column<TopLead>[]}
          />
        </Card>
      )}

      {/* Quick actions */}
      <Grid cols={3} gap={12}>
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
      </Grid>
    </div>
  )
}
