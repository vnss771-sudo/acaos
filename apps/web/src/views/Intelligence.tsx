import React, { useEffect, useState } from 'react'
import type {
  Workspace, OpportunitiesData, ForecastData, Prospect, View,
  StrategyCardsData, StrategyCard, IndustrySignalConfig
} from '../types.js'
import {
  BUYING_STAGE_COLOR, BUYING_STAGE_LABELS, SIGNAL_TYPE_ICONS,
  SIGNAL_TYPE_LABELS, ALL_SIGNAL_TYPES, TIER_COLOR
} from '../types.js'
import { s, colors } from '../styles.js'
import { Spinner, EmptyState } from '../components/Spinner.js'
import type { ApiHook } from '../hooks/useApi.js'
import type { ToastHook } from '../hooks/useToast.js'

type Props = {
  api: ApiHook
  workspace: Workspace | null
  toast: ToastHook
  setView: (v: View) => void
}

type ActiveTab = 'opportunities' | 'strategy-cards' | 'forecast' | 'industry-matrix'

// ── Score Ring ────────────────────────────────────────────────────────────────
function ScoreRing({ score, size = 56 }: { score: number; size?: number }) {
  const tier = score >= 72 ? 'HOT' : score >= 45 ? 'WARM' : 'COLD'
  const color = TIER_COLOR[tier]
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      border: `3px solid ${color}`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0, background: color + '22'
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

// ── Prospect Card ─────────────────────────────────────────────────────────────
function ProspectCard({ prospect, onOutcome }: { prospect: Prospect; onOutcome: (id: string, stage: string) => void }) {
  const [expanded, setExpanded] = useState(false)
  const rec = prospect.topRecommendation
  const sig = prospect.latestSignal
  const signalAge = sig ? Math.round((Date.now() - new Date(sig.detectedAt).getTime()) / 86_400_000) : null

  return (
    <div style={{
      ...s.card, padding: '14px 16px',
      border: `1px solid ${TIER_COLOR[prospect.tier]}33`,
      cursor: 'pointer', transition: 'border-color 0.15s'
    }} onClick={() => setExpanded(e => !e)}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <ScoreRing score={prospect.opportunityScore} />

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2, flexWrap: 'wrap' }}>
            <span style={{ color: colors.text, fontWeight: 600, fontSize: 15 }}>{prospect.companyName}</span>
            <span style={{
              background: BUYING_STAGE_COLOR[prospect.buyingStage] + '33',
              color: BUYING_STAGE_COLOR[prospect.buyingStage],
              fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 99
            }}>{BUYING_STAGE_LABELS[prospect.buyingStage]}</span>
          </div>

          <div style={{ color: colors.textFaint, fontSize: 12, marginBottom: 6 }}>
            {[prospect.industry, prospect.location].filter(Boolean).join(' · ')}
          </div>

          {sig && (
            <div style={{
              background: '#0f172a', borderRadius: 6, padding: '6px 10px',
              display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6
            }}>
              <span style={{ fontSize: 14 }}>{SIGNAL_TYPE_ICONS[sig.type]}</span>
              <span style={{ color: colors.textMuted, fontSize: 12 }}>
                {sig.title || SIGNAL_TYPE_LABELS[sig.type]}
              </span>
              <span style={{ color: colors.textFaint, fontSize: 11, marginLeft: 'auto', flexShrink: 0 }}>
                {signalAge === 0 ? 'today' : `${signalAge}d ago`}
              </span>
            </div>
          )}

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

        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          {prospect.winProbability != null && (
            <div style={{ marginBottom: 4 }}>
              <div style={{ color: colors.green, fontWeight: 700, fontSize: 14 }}>
                {Math.round(prospect.winProbability * 100)}%
              </div>
              <div style={{ color: colors.textFaint, fontSize: 10 }}>win</div>
            </div>
          )}
          {prospect.expectedRevenueScore > 0 && (
            <div>
              <div style={{ color: colors.amber, fontWeight: 700, fontSize: 12 }}>
                ${prospect.expectedRevenueScore.toLocaleString()}
              </div>
              <div style={{ color: colors.textFaint, fontSize: 10 }}>exp. rev</div>
            </div>
          )}
        </div>
      </div>

      {expanded && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${colors.border}` }}
          onClick={e => e.stopPropagation()}>

          <div style={{ marginBottom: 12 }}>
            <div style={{ color: colors.textFaint, fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Score Breakdown</div>
            <ScoreDimension label="Intent" value={prospect.intentScore} />
            <ScoreDimension label="Fit" value={prospect.fitScore} />
            <ScoreDimension label="Timing" value={prospect.timingScore} />
            <ScoreDimension label="Confidence" value={prospect.confidenceScore} />
          </div>

          {rec && (
            <div style={{ background: '#0f172a', borderRadius: 8, padding: 12, marginBottom: 12 }}>
              <div style={{ color: colors.textFaint, fontSize: 10, fontWeight: 600, textTransform: 'uppercase', marginBottom: 8 }}>Strategy Card</div>
              {rec.predictedNeed && (
                <div style={{ marginBottom: 8 }}>
                  <div style={{ color: colors.textFaint, fontSize: 10 }}>Predicted Need</div>
                  <div style={{ color: colors.text, fontSize: 13, fontWeight: 600 }}>{rec.predictedNeed}</div>
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                {rec.meetingProbability != null && (
                  <div>
                    <div style={{ color: colors.textFaint, fontSize: 10 }}>Meeting Prob</div>
                    <div style={{ color: colors.green, fontSize: 16, fontWeight: 700 }}>
                      {Math.round(rec.meetingProbability * 100)}%
                    </div>
                  </div>
                )}
                {rec.expectedRevenue != null && (
                  <div>
                    <div style={{ color: colors.textFaint, fontSize: 10 }}>Exp. Revenue</div>
                    <div style={{ color: colors.amber, fontSize: 16, fontWeight: 700 }}>
                      ${rec.expectedRevenue.toLocaleString()}
                    </div>
                  </div>
                )}
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
              </div>
              {rec.reasoning && (
                <div style={{ color: colors.textMuted, fontSize: 12, fontStyle: 'italic' }}>{rec.reasoning}</div>
              )}
            </div>
          )}

          {(prospect.contactName || prospect.contactEmail) && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ color: colors.textFaint, fontSize: 10, fontWeight: 600, textTransform: 'uppercase', marginBottom: 4 }}>Contact</div>
              <div style={{ color: colors.text, fontSize: 13 }}>{prospect.contactName}</div>
              {prospect.contactTitle && <div style={{ color: colors.textFaint, fontSize: 12 }}>{prospect.contactTitle}</div>}
              {prospect.contactEmail && <div style={{ color: colors.blueLight, fontSize: 12 }}>{prospect.contactEmail}</div>}
            </div>
          )}

          <div>
            <div style={{ color: colors.textFaint, fontSize: 10, fontWeight: 600, textTransform: 'uppercase', marginBottom: 6 }}>Move to Stage</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {(['CONTACTED', 'MEETING', 'PROPOSAL', 'WON', 'LOST'] as const).map(stage => (
                <button key={stage} onClick={() => onOutcome(prospect.id, stage)}
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

// ── Tier Section ──────────────────────────────────────────────────────────────
function TierSection({ title, prospects, color, onOutcome }: {
  title: string; prospects: Prospect[]; color: string; onOutcome: (id: string, stage: string) => void
}) {
  const [collapsed, setCollapsed] = useState(false)
  return (
    <div>
      <button onClick={() => setCollapsed(c => !c)} style={{
        width: '100%', background: 'none', border: 'none', cursor: 'pointer',
        display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, padding: 0
      }}>
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
        <span style={{ color, fontWeight: 700, fontSize: 12, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{title}</span>
        <span style={{ background: color + '22', color, fontSize: 10, fontWeight: 700, padding: '1px 8px', borderRadius: 99 }}>{prospects.length}</span>
        <span style={{ color: colors.textFaint, marginLeft: 'auto', fontSize: 11 }}>{collapsed ? '▶' : '▼'}</span>
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

// ── Strategy Cards Panel ──────────────────────────────────────────────────────
function StrategyCardsPanel({ data, onOutcome }: { data: StrategyCardsData; onOutcome: (id: string, stage: string) => void }) {
  if (data.strategyCards.length === 0) {
    return (
      <div style={s.card}>
        <EmptyState message="No strategy cards yet. Score prospects to generate them." icon="◈" />
      </div>
    )
  }

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {data.strategyCards.map((card, idx) => <StrategyCardRow key={card.id} card={card} rank={idx + 1} onOutcome={onOutcome} />)}
    </div>
  )
}

function StrategyCardRow({ card, rank, onOutcome }: { card: StrategyCard; rank: number; onOutcome: (id: string, stage: string) => void }) {
  const [expanded, setExpanded] = useState(false)
  const rec = card.recommendation

  return (
    <div style={{
      ...s.card, padding: '14px 16px',
      border: `1px solid ${TIER_COLOR[card.tier]}33`,
      cursor: 'pointer'
    }} onClick={() => setExpanded(e => !e)}>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
        {/* Rank */}
        <div style={{
          width: 28, height: 28, borderRadius: '50%',
          background: '#1e2d40', display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: colors.textFaint, fontSize: 12, fontWeight: 700, flexShrink: 0
        }}>#{rank}</div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
            <span style={{ color: colors.text, fontWeight: 600, fontSize: 15 }}>{card.companyName}</span>
            <span style={{
              background: BUYING_STAGE_COLOR[card.buyingStage] + '33',
              color: BUYING_STAGE_COLOR[card.buyingStage],
              fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 99
            }}>{BUYING_STAGE_LABELS[card.buyingStage]}</span>
          </div>
          {card.industry && (
            <div style={{ color: colors.textFaint, fontSize: 12 }}>
              {[card.industry, card.location].filter(Boolean).join(' · ')}
            </div>
          )}
          {rec?.predictedNeed && (
            <div style={{ color: colors.textMuted, fontSize: 12, marginTop: 3 }}>
              Need: <span style={{ color: colors.text, fontWeight: 500 }}>{rec.predictedNeed}</span>
            </div>
          )}
        </div>

        <div style={{ textAlign: 'right', flexShrink: 0, display: 'flex', gap: 16, alignItems: 'center' }}>
          <div>
            <div style={{ color: colors.amber, fontWeight: 800, fontSize: 18 }}>
              {card.expectedRevenueScore > 0 ? `$${card.expectedRevenueScore.toLocaleString()}` : '–'}
            </div>
            <div style={{ color: colors.textFaint, fontSize: 10 }}>exp. revenue</div>
          </div>
          {rec?.meetingProbability != null && (
            <div>
              <div style={{ color: colors.green, fontWeight: 700, fontSize: 16 }}>
                {Math.round(rec.meetingProbability * 100)}%
              </div>
              <div style={{ color: colors.textFaint, fontSize: 10 }}>meeting</div>
            </div>
          )}
          <div>
            <div style={{ color: TIER_COLOR[card.tier], fontWeight: 700, fontSize: 14 }}>{card.opportunityScore}</div>
            <div style={{ color: colors.textFaint, fontSize: 10 }}>score</div>
          </div>
        </div>
      </div>

      {expanded && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${colors.border}` }}
          onClick={e => e.stopPropagation()}>
          {rec ? (
            <div style={{ background: '#0f172a', borderRadius: 8, padding: 12, marginBottom: 12 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, marginBottom: 10 }}>
                {rec.bestChannel && (
                  <div>
                    <div style={{ color: colors.textFaint, fontSize: 10 }}>CHANNEL</div>
                    <div style={{ color: colors.text, fontSize: 13, fontWeight: 600 }}>{rec.bestChannel}</div>
                  </div>
                )}
                {rec.bestTiming && (
                  <div>
                    <div style={{ color: colors.textFaint, fontSize: 10 }}>TIMING</div>
                    <div style={{ color: colors.text, fontSize: 13 }}>{rec.bestTiming}</div>
                  </div>
                )}
                {rec.messageAngle && (
                  <div>
                    <div style={{ color: colors.textFaint, fontSize: 10 }}>ANGLE</div>
                    <div style={{ color: colors.text, fontSize: 13 }}>{rec.messageAngle}</div>
                  </div>
                )}
                {card.contactEmail && (
                  <div>
                    <div style={{ color: colors.textFaint, fontSize: 10 }}>CONTACT</div>
                    <div style={{ color: colors.blueLight, fontSize: 13 }}>{card.contactEmail}</div>
                  </div>
                )}
              </div>
              {rec.actionText && (
                <div style={{ color: colors.blueLight, fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{rec.actionText}</div>
              )}
              {rec.reasoning && (
                <div style={{ color: colors.textFaint, fontSize: 12, fontStyle: 'italic' }}>{rec.reasoning}</div>
              )}
            </div>
          ) : (
            <div style={{ color: colors.textFaint, fontSize: 13, marginBottom: 12 }}>No strategy card yet — run score-prospects to generate one.</div>
          )}

          <div>
            <div style={{ color: colors.textFaint, fontSize: 10, fontWeight: 600, textTransform: 'uppercase', marginBottom: 6 }}>Move to Stage</div>
            <div style={{ display: 'flex', gap: 6 }}>
              {(['CONTACTED', 'MEETING', 'PROPOSAL', 'WON', 'LOST'] as const).map(stage => (
                <button key={stage} onClick={() => onOutcome(card.id, stage)}
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

// ── Forecast Panel ────────────────────────────────────────────────────────────
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

// ── Industry Matrix Panel ─────────────────────────────────────────────────────
function IndustryMatrixPanel({ workspaceId, api, toast }: { workspaceId: string; api: ApiHook; toast: ToastHook }) {
  const [configs, setConfigs] = useState<IndustrySignalConfig[]>([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [newIndustry, setNewIndustry] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [newBoosts, setNewBoosts] = useState<Record<string, number>>({})
  const [saving, setSaving] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const load = () => {
    setLoading(true)
    api<{ configs: IndustrySignalConfig[] }>(`/api/intelligence/industry-configs?workspaceId=${workspaceId}`)
      .then(d => setConfigs(d.configs))
      .catch(e => toast.error(e.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [workspaceId])

  const handleSave = async () => {
    if (!newIndustry.trim()) return
    setSaving(true)
    try {
      await api(`/api/intelligence/industry-configs/${encodeURIComponent(newIndustry.toLowerCase())}`, {
        method: 'PUT',
        body: JSON.stringify({ workspaceId, signalBoosts: newBoosts, description: newDescription || null })
      })
      toast.success(`Industry config saved for "${newIndustry}"`)
      setShowAdd(false)
      setNewIndustry('')
      setNewDescription('')
      setNewBoosts({})
      load()
    } catch (e: unknown) { toast.error((e as Error).message) }
    finally { setSaving(false) }
  }

  const handleDelete = async (industry: string) => {
    if (!confirm(`Delete config for "${industry}"?`)) return
    try {
      await api(`/api/intelligence/industry-configs/${encodeURIComponent(industry)}?workspaceId=${workspaceId}`, { method: 'DELETE' })
      toast.success(`Deleted config for "${industry}"`)
      load()
    } catch (e: unknown) { toast.error((e as Error).message) }
  }

  if (loading) return <div style={{ textAlign: 'center', padding: 40 }}><Spinner /></div>

  return (
    <div style={s.stack}>
      <div style={{ ...s.flexBetween }}>
        <div style={{ color: colors.textMuted, fontSize: 13 }}>
          Per-industry signal boost overrides. Higher values (0–100) prioritize that signal type for matching companies.
        </div>
        <button style={s.btn} onClick={() => setShowAdd(true)}>+ Add Industry</button>
      </div>

      {showAdd && (
        <div style={s.card}>
          <div style={{ ...s.sectionHeader, marginBottom: 12 }}>New Industry Config</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
            <div>
              <label style={s.label}>Industry Name</label>
              <input type="text" value={newIndustry}
                onChange={e => setNewIndustry(e.target.value)}
                placeholder="e.g. construction" style={s.input} />
            </div>
            <div>
              <label style={s.label}>Description (optional)</label>
              <input type="text" value={newDescription}
                onChange={e => setNewDescription(e.target.value)}
                placeholder="e.g. Construction & civil contractors" style={s.input} />
            </div>
          </div>
          <div style={{ marginBottom: 12 }}>
            <div style={{ color: colors.textFaint, fontSize: 11, marginBottom: 8 }}>Signal Boosts (0–100, leave blank to use default)</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
              {ALL_SIGNAL_TYPES.map(type => (
                <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 13 }}>{SIGNAL_TYPE_ICONS[type]}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: colors.textFaint, fontSize: 10 }}>{SIGNAL_TYPE_LABELS[type]}</div>
                    <input type="number" min={0} max={100}
                      value={newBoosts[type] ?? ''}
                      onChange={e => {
                        const v = e.target.value
                        setNewBoosts(b => v ? { ...b, [type]: Number(v) } : Object.fromEntries(Object.entries(b).filter(([k]) => k !== type)))
                      }}
                      style={{ ...s.input, padding: '3px 6px', fontSize: 11 }}
                      placeholder="–"
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={handleSave} disabled={saving || !newIndustry.trim()} style={s.btn}>
              {saving ? 'Saving…' : 'Save Config'}
            </button>
            <button onClick={() => setShowAdd(false)} style={s.btnGhost}>Cancel</button>
          </div>
        </div>
      )}

      {configs.length === 0 && !showAdd ? (
        <div style={s.card}>
          <EmptyState message="No industry configs yet. Add one to customize signal weights per industry." icon="⚙" />
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          {configs.map(cfg => (
            <div key={cfg.id} style={{ ...s.card, padding: '12px 16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ color: colors.text, fontWeight: 700, fontSize: 14, textTransform: 'capitalize' }}>
                    {cfg.industry}
                  </div>
                  {cfg.description && <div style={{ color: colors.textFaint, fontSize: 12 }}>{cfg.description}</div>}
                  <div style={{ color: colors.textFaint, fontSize: 11, marginTop: 2 }}>
                    {Object.keys(cfg.signalBoosts).length} signal overrides
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button style={s.btnSm} onClick={() => setExpandedId(expandedId === cfg.id ? null : cfg.id)}>
                    {expandedId === cfg.id ? 'Hide' : 'View'}
                  </button>
                  <button style={{ ...s.btnSm, color: colors.red, borderColor: colors.red + '44' }}
                    onClick={() => handleDelete(cfg.industry)}>
                    Delete
                  </button>
                </div>
              </div>

              {expandedId === cfg.id && (
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${colors.border}` }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {ALL_SIGNAL_TYPES.filter(t => cfg.signalBoosts[t] != null).map(t => (
                      <div key={t} style={{
                        background: '#1e2d40', borderRadius: 6, padding: '4px 10px',
                        display: 'flex', alignItems: 'center', gap: 6
                      }}>
                        <span>{SIGNAL_TYPE_ICONS[t]}</span>
                        <span style={{ color: colors.textFaint, fontSize: 11 }}>{SIGNAL_TYPE_LABELS[t]}</span>
                        <span style={{ color: colors.amber, fontWeight: 700, fontSize: 12 }}>{cfg.signalBoosts[t]}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Main Intelligence View ────────────────────────────────────────────────────
export function Intelligence({ api, workspace, toast, setView }: Props) {
  const [opportunities, setOpportunities] = useState<OpportunitiesData | null>(null)
  const [strategyCards, setStrategyCards] = useState<StrategyCardsData | null>(null)
  const [forecast, setForecast] = useState<ForecastData | null>(null)
  const [loading, setLoading] = useState(false)
  const [activeTab, setActiveTab] = useState<ActiveTab>('opportunities')

  const load = () => {
    if (!workspace) return
    setLoading(true)
    Promise.all([
      api<OpportunitiesData>(`/api/intelligence/opportunities?workspaceId=${workspace.id}`),
      api<StrategyCardsData>(`/api/intelligence/strategy-cards?workspaceId=${workspace.id}&limit=20`),
      api<ForecastData>(`/api/intelligence/forecast?workspaceId=${workspace.id}`)
    ])
      .then(([opp, sc, fc]) => { setOpportunities(opp); setStrategyCards(sc); setForecast(fc) })
      .catch(e => toast.error(e.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [workspace?.id])

  const handleOutcome = async (prospectId: string, stage: string) => {
    if (!workspace) return
    try {
      await api(`/api/prospects/${prospectId}/outcome`, {
        method: 'POST',
        body: JSON.stringify({ stage })
      })
      toast.success(`Moved to ${stage}`)
      load()
    } catch (e: unknown) { toast.error((e as Error).message) }
  }

  if (!workspace) {
    return <div style={s.card}><EmptyState message="No workspace selected" icon="◈" /></div>
  }

  const totals = opportunities?.totals

  const TABS: { key: ActiveTab; label: string }[] = [
    { key: 'opportunities', label: 'Opportunities' },
    { key: 'strategy-cards', label: 'Strategy Cards' },
    { key: 'forecast', label: 'Revenue Forecast' },
    { key: 'industry-matrix', label: 'Industry Matrix' },
  ]

  return (
    <div style={s.stack}>
      {/* KPI Bar */}
      <div style={s.grid4}>
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
          <div style={{ color: colors.textFaint, fontSize: 10, fontWeight: 600, textTransform: 'uppercase', marginBottom: 6 }}>Strategy Cards</div>
          <div style={{ color: colors.amber, fontSize: 28, fontWeight: 800 }}>
            {loading ? '…' : (strategyCards?.strategyCards.length ?? 0)}
          </div>
          <div style={{ color: colors.textFaint, fontSize: 11 }}>by expected revenue</div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, background: colors.bgSurface, borderRadius: 8, padding: 4, border: `1px solid ${colors.border}`, width: 'fit-content', flexWrap: 'wrap' }}>
        {TABS.map(({ key, label }) => (
          <button key={key} onClick={() => setActiveTab(key)} style={{
            ...s.btnSm,
            background: activeTab === key ? (key === 'strategy-cards' ? colors.amber : colors.blue) : 'transparent',
            color: activeTab === key ? (key === 'strategy-cards' ? '#000' : '#fff') : colors.textMuted,
            fontWeight: activeTab === key ? 600 : 400, padding: '6px 16px', fontSize: 13
          }}>
            {label}
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
      ) : activeTab === 'strategy-cards' ? (
        strategyCards ? (
          <StrategyCardsPanel data={strategyCards} onOutcome={handleOutcome} />
        ) : (
          <div style={s.card}><EmptyState message="No strategy cards yet." icon="◈" /></div>
        )
      ) : activeTab === 'forecast' ? (
        forecast ? <ForecastPanel forecast={forecast} /> : null
      ) : (
        <IndustryMatrixPanel workspaceId={workspace.id} api={api} toast={toast} />
      )}
    </div>
  )
}
