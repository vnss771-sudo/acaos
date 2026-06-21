import React, { useEffect, useState, useRef, useMemo } from 'react'
import type { OutcomeStage } from '@acaos/shared'
import type { Workspace, OpportunitiesData, ForecastData, Prospect, Signal, View } from '../types.js'
import { BUYING_STAGE_COLOR, BUYING_STAGE_LABELS, SIGNAL_TYPE_ICONS, TIER_COLOR } from '../types.js'
import { s, colors } from '../styles.js'
import { Spinner, EmptyState } from '../components/Spinner.js'
import { Grid } from '../components/ui/Grid.js'
import { makeRouteApi } from '../lib/routeApi.js'
import type { ApiHook } from '../hooks/useApi.js'
import type { ToastHook } from '../hooks/useToast.js'

type Props = {
  api: ApiHook
  workspace: Workspace | null
  toast: ToastHook
  setView: (v: View) => void
}

function ScoreRing({ score, size = 56 }: { score: number; size?: number }) {
  const tier = score >= 72 ? 'HOT' : score >= 45 ? 'WARM' : 'COLD'
  const color = TIER_COLOR[tier]
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      border: `3px solid ${color}`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0,
      background: color + '22'
    }}>
      <span style={{ color, fontWeight: 800, fontSize: size * 0.28 }}>{score}</span>
    </div>
  )
}

function ScoreDimension({ label, value }: { label: string; value: number }) {
  const color = value >= 70 ? colors.green : value >= 45 ? colors.amber : colors.textFaint
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
      <div style={{ width: 60, height: 4, background: '#1e2d40', borderRadius: 2, flex: 1 }}>
        <div style={{ width: `${value}%`, height: '100%', background: color, borderRadius: 2 }} />
      </div>
      <span style={{ color: colors.textFaint, fontSize: 10, width: 24, textAlign: 'right' }}>{value}</span>
      <span style={{ color: colors.textFaint, fontSize: 10, width: 52 }}>{label}</span>
    </div>
  )
}

type ConfidenceTier = { label: string; color: string }
function getConfidenceTier(score: number): ConfidenceTier {
  if (score >= 75) return { label: 'Confirmed', color: '#22c55e' }
  if (score >= 50) return { label: 'Likely',    color: '#3b82f6' }
  if (score >= 30) return { label: 'Weak',       color: '#f59e0b' }
  return                  { label: 'Needs Review', color: '#64748b' }
}

function buildWhyNow(signals: Signal[] | undefined, latestSignal: Signal | null | undefined): string | null {
  const sigs = signals ?? (latestSignal ? [latestSignal] : [])
  if (sigs.length === 0) return null
  const uniqueTypes = [...new Set(sigs.map(s => s.type))]
  const typeLabels: Record<string, string> = {
    HIRING: 'Hiring spike', FUNDING: 'Funding event', EXPANSION: 'Expansion detected',
    TECH_ADOPTION: 'Tech adoption', LEADERSHIP_CHANGE: 'Leadership change',
    NEWS_MENTION: 'In the news', PROCUREMENT: 'Procurement signal', BUSINESS_REGISTRATION: 'New registration',
    WEBSITE_CHANGE: 'Website update'
  }
  const parts = uniqueTypes.slice(0, 2).map(t => typeLabels[t] ?? t.replace(/_/g, ' '))
  const newest = sigs.reduce((a, b) => new Date(a.detectedAt) > new Date(b.detectedAt) ? a : b)
  const ageInDays = Math.round((Date.now() - new Date(newest.detectedAt).getTime()) / 86_400_000)
  const ageStr = ageInDays === 0 ? 'today' : `${ageInDays}d ago`
  return `${parts.join(' · ')} · ${sigs.length} signal${sigs.length !== 1 ? 's' : ''} · ${ageStr}`
}

function ProspectCard({ prospect, onOutcome }: { prospect: Prospect; onOutcome: (id: string, stage: string) => void }) {
  const [expanded, setExpanded] = useState(false)
  const rec = prospect.topRecommendation
  const sig = prospect.latestSignal

  const signalAge = sig ? Math.round((Date.now() - new Date(sig.detectedAt).getTime()) / 86_400_000) : null
  const confidence = getConfidenceTier(prospect.confidenceScore)
  const whyNow = buildWhyNow(prospect.signals, prospect.latestSignal)

  return (
    <div style={{
      ...s.card, padding: '14px 16px',
      border: `1px solid ${TIER_COLOR[prospect.tier]}33`,
      cursor: 'pointer', transition: 'border-color 0.15s'
    }}
      onClick={() => setExpanded(e => !e)}
    >
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <ScoreRing score={prospect.opportunityScore} />

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2, flexWrap: 'wrap' }}>
            <span style={{ color: colors.text, fontWeight: 600, fontSize: 15 }}>{prospect.companyName}</span>
            {prospect.isExample && (
              <span style={{
                background: '#64748b22', color: '#94a3b8',
                fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 99, letterSpacing: '0.06em'
              }}>EXAMPLE</span>
            )}
            <span style={{
              background: BUYING_STAGE_COLOR[prospect.buyingStage] + '33',
              color: BUYING_STAGE_COLOR[prospect.buyingStage],
              fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 99, letterSpacing: '0.04em'
            }}>{BUYING_STAGE_LABELS[prospect.buyingStage]}</span>
            <span style={{
              background: confidence.color + '22',
              color: confidence.color,
              fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 99
            }}>{confidence.label}</span>
          </div>

          <div style={{ color: colors.textFaint, fontSize: 12, marginBottom: 6 }}>
            {[prospect.industry, prospect.location].filter(Boolean).join(' · ')}
          </div>

          {/* Why Now evidence */}
          {whyNow && (
            <div style={{
              color: colors.amber, fontSize: 11, fontWeight: 600,
              marginBottom: 5, letterSpacing: '0.01em'
            }}>
              ⚡ {whyNow}
            </div>
          )}

          {/* Latest signal */}
          {!whyNow && sig && (
            <div style={{
              background: '#0f172a', borderRadius: 6, padding: '6px 10px',
              display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6
            }}>
              <span style={{ fontSize: 14 }}>{SIGNAL_TYPE_ICONS[sig.type]}</span>
              <span style={{ color: colors.textMuted, fontSize: 12 }}>
                {sig.title || sig.type.replace(/_/g, ' ')}
              </span>
              <span style={{ color: colors.textFaint, fontSize: 11, marginLeft: 'auto', flexShrink: 0 }}>
                {signalAge === 0 ? 'today' : `${signalAge}d ago`}
              </span>
            </div>
          )}

          {/* Recommendation */}
          {rec && (
            <div style={{ color: colors.textMuted, fontSize: 12 }}>
              <span style={{
                color: rec.urgency === 'HIGH' ? colors.red : rec.urgency === 'MEDIUM' ? colors.amber : colors.textFaint,
                fontWeight: 700, marginRight: 4
              }}>{rec.urgency}</span>
              {rec.actionText}
            </div>
          )}
        </div>

        {prospect.winProbability != null && (
          <div style={{ textAlign: 'right', flexShrink: 0 }}>
            <div style={{ color: colors.green, fontWeight: 700, fontSize: 14 }}>
              {Math.round(prospect.winProbability * 100)}%
            </div>
            <div style={{ color: colors.textFaint, fontSize: 10 }}>win prob</div>
          </div>
        )}
      </div>

      {expanded && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${colors.border}` }}
          onClick={e => e.stopPropagation()}>

          {/* Score breakdown */}
          <div style={{ marginBottom: 12 }}>
            <div style={{ color: colors.textFaint, fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Score Breakdown</div>
            <ScoreDimension label="Intent" value={prospect.intentScore} />
            <ScoreDimension label="Fit" value={prospect.fitScore} />
            <ScoreDimension label="Timing" value={prospect.timingScore} />
            <ScoreDimension label="Confidence" value={prospect.confidenceScore} />
          </div>

          {/* Full recommendation */}
          {rec && (
            <div style={{ background: '#0f172a', borderRadius: 8, padding: 12, marginBottom: 12 }}>
              <div style={{ color: colors.textFaint, fontSize: 10, fontWeight: 600, textTransform: 'uppercase', marginBottom: 8 }}>AI Recommendation</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                {rec.bestContact && (
                  <div>
                    <div style={{ color: colors.textFaint, fontSize: 10 }}>Contact</div>
                    <div style={{ color: colors.text, fontSize: 12 }}>{rec.bestContact}</div>
                  </div>
                )}
                {rec.bestChannel && (
                  <div>
                    <div style={{ color: colors.textFaint, fontSize: 10 }}>Channel</div>
                    <div style={{ color: colors.text, fontSize: 12 }}>{rec.bestChannel}</div>
                  </div>
                )}
                {rec.bestTiming && (
                  <div>
                    <div style={{ color: colors.textFaint, fontSize: 10 }}>Timing</div>
                    <div style={{ color: colors.text, fontSize: 12 }}>{rec.bestTiming}</div>
                  </div>
                )}
                {rec.messageAngle && (
                  <div>
                    <div style={{ color: colors.textFaint, fontSize: 10 }}>Angle</div>
                    <div style={{ color: colors.text, fontSize: 12 }}>{rec.messageAngle}</div>
                  </div>
                )}
              </div>
              {rec.reasoning && (
                <div style={{ color: colors.textMuted, fontSize: 12, fontStyle: 'italic' }}>{rec.reasoning}</div>
              )}
            </div>
          )}

          {/* Contact info */}
          {(prospect.contactName || prospect.contactEmail) && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ color: colors.textFaint, fontSize: 10, fontWeight: 600, textTransform: 'uppercase', marginBottom: 4 }}>Contact</div>
              <div style={{ color: colors.text, fontSize: 13 }}>{prospect.contactName}</div>
              {prospect.contactTitle && <div style={{ color: colors.textFaint, fontSize: 12 }}>{prospect.contactTitle}</div>}
              {prospect.contactEmail && <div style={{ color: colors.blueLight, fontSize: 12 }}>{prospect.contactEmail}</div>}
            </div>
          )}

          {/* Outcome actions */}
          <div>
            <div style={{ color: colors.textFaint, fontSize: 10, fontWeight: 600, textTransform: 'uppercase', marginBottom: 6 }}>Move to Stage</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {(['CONTACTED', 'MEETING', 'PROPOSAL', 'WON', 'LOST'] as const).map(stage => (
                <button key={stage}
                  onClick={() => onOutcome(prospect.id, stage)}
                  style={{
                    ...s.btnSm, fontSize: 11,
                    background: stage === 'WON' ? '#14532d' : stage === 'LOST' ? '#7f1d1d' : '#1e2d40',
                    color: stage === 'WON' ? '#86efac' : stage === 'LOST' ? '#fca5a5' : colors.textMuted
                  }}>
                  {stage}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function TierSection({ title, prospects, color, onOutcome }: {
  title: string; prospects: Prospect[]; color: string; onOutcome: (id: string, stage: string) => void
}) {
  const [collapsed, setCollapsed] = useState(false)
  return (
    <div>
      <button
        onClick={() => setCollapsed(c => !c)}
        style={{
          width: '100%', background: 'none', border: 'none', cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, padding: 0
        }}>
        <div style={{
          width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0
        }} />
        <span style={{ color, fontWeight: 700, fontSize: 12, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          {title}
        </span>
        <span style={{
          background: color + '22', color, fontSize: 10, fontWeight: 700,
          padding: '1px 8px', borderRadius: 99, marginLeft: 2
        }}>{prospects.length}</span>
        <span style={{ color: colors.textFaint, marginLeft: 'auto', fontSize: 11 }}>
          {collapsed ? '▶' : '▼'}
        </span>
      </button>
      {!collapsed && (
        <div style={{ display: 'grid', gap: 8 }}>
          {prospects.length === 0 ? (
            <div style={{ color: colors.textFaint, fontSize: 13, padding: '8px 0' }}>No {title.toLowerCase()} prospects</div>
          ) : (
            prospects.map(p => <ProspectCard key={p.id} prospect={p} onOutcome={onOutcome} />)
          )}
        </div>
      )}
    </div>
  )
}

function ForecastPanel({ forecast }: { forecast: ForecastData }) {
  const s2 = forecast.summary
  return (
    <div style={s.card}>
      <div style={{ ...s.sectionHeader, marginBottom: 14 }}>Revenue Forecast</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 16 }}>
        <div style={s.cardInner}>
          <div style={{ color: colors.textFaint, fontSize: 10, marginBottom: 4 }}>Weighted Forecast</div>
          <div style={{ color: colors.green, fontWeight: 800, fontSize: 20 }}>${s2.weightedForecast.toLocaleString()}</div>
        </div>
        <div style={s.cardInner}>
          <div style={{ color: colors.textFaint, fontSize: 10, marginBottom: 4 }}>Pipeline Value</div>
          <div style={{ color: colors.blue, fontWeight: 700, fontSize: 20 }}>${s2.totalPipelineValue.toLocaleString()}</div>
        </div>
        <div style={s.cardInner}>
          <div style={{ color: colors.textFaint, fontSize: 10, marginBottom: 4 }}>Won Revenue</div>
          <div style={{ color: colors.amber, fontWeight: 700, fontSize: 20 }}>${s2.wonRevenue.toLocaleString()}</div>
        </div>
      </div>

      {/* Stage breakdown */}
      {Object.entries(forecast.stageBreakdown).map(([stage, data]) => (
        <div key={stage} style={{ marginBottom: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
            <span style={{ color: colors.textMuted, fontSize: 12 }}>{stage}</span>
            <span style={{ color: colors.text, fontSize: 12 }}>
              {data.count} prospects · ${data.forecast.toLocaleString()}
            </span>
          </div>
          <div style={{ background: '#1e2d40', borderRadius: 3, height: 4 }}>
            <div style={{
              width: `${s2.weightedForecast > 0 ? Math.min(100, (data.forecast / s2.weightedForecast) * 100) : 0}%`,
              height: '100%', background: BUYING_STAGE_COLOR[stage as keyof typeof BUYING_STAGE_COLOR] || colors.blue,
              borderRadius: 3
            }} />
          </div>
        </div>
      ))}
    </div>
  )
}

export function Intelligence({ api, workspace, toast, setView }: Props) {
  const route = useMemo(() => makeRouteApi(api), [api])
  const [opportunities, setOpportunities] = useState<OpportunitiesData | null>(null)
  const [forecast, setForecast] = useState<ForecastData | null>(null)
  const [loading, setLoading] = useState(false)
  const [activeTab, setActiveTab] = useState<'opportunities' | 'forecast'>('opportunities')

  // Monotonic request id so a slow earlier load can't overwrite a newer one when
  // the workspace switches.
  const loadReqRef = useRef(0)
  const load = () => {
    if (!workspace) return
    const reqId = ++loadReqRef.current
    setLoading(true)
    Promise.all([
      api<OpportunitiesData>(`/api/intelligence/opportunities?workspaceId=${workspace.id}`),
      api<ForecastData>(`/api/intelligence/forecast?workspaceId=${workspace.id}`)
    ])
      .then(([opp, fc]) => { if (reqId === loadReqRef.current) { setOpportunities(opp); setForecast(fc) } })
      .catch(e => { if (reqId === loadReqRef.current) toast.error(e.message) })
      .finally(() => { if (reqId === loadReqRef.current) setLoading(false) })
  }

  useEffect(() => { load() }, [workspace?.id])

  const handleOutcome = async (prospectId: string, stage: string) => {
    if (!workspace) return
    try {
      await route('POST /api/prospects/:id/outcome', {
        params: { id: prospectId },
        body: { stage: stage as OutcomeStage }
      })
      toast.success(`Moved to ${stage}`)
      load()
    } catch (e: unknown) {
      toast.error((e as Error).message)
    }
  }

  if (!workspace) {
    return <div style={s.card}><EmptyState message="No workspace selected" icon="◈" /></div>
  }

  const totals = opportunities?.totals

  return (
    <div style={s.stack}>
      {/* KPI Bar */}
      <Grid cols={4}>
        <div style={s.card}>
          <div style={{ color: colors.textFaint, fontSize: 10, fontWeight: 600, textTransform: 'uppercase', marginBottom: 6 }}>Total Prospects</div>
          <div style={{ color: colors.blueLight, fontSize: 28, fontWeight: 800 }}>{loading ? '…' : (totals?.total ?? 0)}</div>
        </div>
        <div style={s.card}>
          <div style={{ color: colors.textFaint, fontSize: 10, fontWeight: 600, textTransform: 'uppercase', marginBottom: 6 }}>Hot</div>
          <div style={{ color: TIER_COLOR.HOT, fontSize: 28, fontWeight: 800 }}>{loading ? '…' : (totals?.hot ?? 0)}</div>
          <div style={{ color: colors.textFaint, fontSize: 11 }}>Score ≥ 72</div>
        </div>
        <div style={s.card}>
          <div style={{ color: colors.textFaint, fontSize: 10, fontWeight: 600, textTransform: 'uppercase', marginBottom: 6 }}>Warm</div>
          <div style={{ color: TIER_COLOR.WARM, fontSize: 28, fontWeight: 800 }}>{loading ? '…' : (totals?.warm ?? 0)}</div>
          <div style={{ color: colors.textFaint, fontSize: 11 }}>Score 45–71</div>
        </div>
        <div style={s.card}>
          <div style={{ color: colors.textFaint, fontSize: 10, fontWeight: 600, textTransform: 'uppercase', marginBottom: 6 }}>Weighted Forecast</div>
          <div style={{ color: colors.green, fontSize: 22, fontWeight: 800 }}>
            {loading ? '…' : forecast ? `$${forecast.summary.weightedForecast.toLocaleString()}` : '$0'}
          </div>
        </div>
      </Grid>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, background: colors.bgSurface, borderRadius: 8, padding: 4, border: `1px solid ${colors.border}`, width: 'fit-content' }}>
        {(['opportunities', 'forecast'] as const).map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)} style={{
            ...s.btnSm,
            background: activeTab === tab ? colors.blue : 'transparent',
            color: activeTab === tab ? '#fff' : colors.textMuted,
            fontWeight: activeTab === tab ? 600 : 400, padding: '6px 16px', fontSize: 13
          }}>
            {tab === 'opportunities' ? 'Opportunities' : 'Revenue Forecast'}
          </button>
        ))}
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 40 }}><Spinner /></div>
      ) : activeTab === 'opportunities' ? (
        opportunities ? (
          <div style={{ display: 'grid', gap: 24 }}>
            <TierSection title="Hot" prospects={opportunities.hot} color={TIER_COLOR.HOT} onOutcome={handleOutcome} />
            <TierSection title="Warm" prospects={opportunities.warm} color={TIER_COLOR.WARM} onOutcome={handleOutcome} />
            <TierSection title="Cold" prospects={opportunities.cold} color={TIER_COLOR.COLD} onOutcome={handleOutcome} />
          </div>
        ) : (
          <div style={s.card}>
            <EmptyState message="No prospects yet. Add your first prospect to get started." icon="◈" />
            <div style={{ textAlign: 'center', marginTop: 12 }}>
              <button style={s.btn} onClick={() => setView('prospects')}>Add Prospect</button>
            </div>
          </div>
        )
      ) : (
        forecast && <ForecastPanel forecast={forecast} />
      )}
    </div>
  )
}
