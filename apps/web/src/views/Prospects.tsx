import React, { useEffect, useState } from 'react'
import type { Workspace, Prospect, Signal, Recommendation } from '../types.js'
import {
  ALL_SIGNAL_TYPES, BUYING_STAGE_COLOR, BUYING_STAGE_LABELS, OUTCOME_STAGE_COLOR,
  SIGNAL_TYPE_ICONS, SIGNAL_TYPE_LABELS, TIER_COLOR
} from '../types.js'
import type { SignalType, BuyingStage, OutcomeStage } from '../types.js'
import { s, colors } from '../styles.js'
import { Spinner, EmptyState } from '../components/Spinner.js'
import type { ApiHook } from '../hooks/useApi.js'
import type { ToastHook } from '../hooks/useToast.js'

type Props = { api: ApiHook; workspace: Workspace | null; toast: ToastHook }
type SortBy = 'opportunityScore' | 'expectedRevenueScore'

function SignalBadge({ signal }: { signal: Signal }) {
  const ageInDays = Math.round((Date.now() - new Date(signal.detectedAt).getTime()) / 86_400_000)
  return (
    <div style={{
      background: '#0f172a', border: `1px solid ${colors.border}`,
      borderRadius: 6, padding: '6px 10px',
      display: 'flex', alignItems: 'center', gap: 8
    }}>
      <span>{SIGNAL_TYPE_ICONS[signal.type]}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color: colors.text, fontSize: 12, fontWeight: 600 }}>
          {SIGNAL_TYPE_LABELS[signal.type]}
        </div>
        {signal.title && <div style={{ color: colors.textFaint, fontSize: 11 }}>{signal.title}</div>}
        {signal.buyingImplication && (
          <div style={{ color: colors.textFaint, fontSize: 10, fontStyle: 'italic' }}>
            {signal.buyingImplication.replace(/_/g, ' ')}
          </div>
        )}
      </div>
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <div style={{ color: colors.amber, fontSize: 11, fontWeight: 700 }}>{signal.strength}</div>
        <div style={{ color: colors.textFaint, fontSize: 10 }}>
          {ageInDays === 0 ? 'today' : `${ageInDays}d ago`}
        </div>
      </div>
    </div>
  )
}

function AddSignalForm({ prospectId, workspaceId, api, onDone, toast }: {
  prospectId: string; workspaceId: string; api: ApiHook; onDone: () => void; toast: ToastHook
}) {
  const [type, setType] = useState<SignalType>('CONTRACT_AWARDED')
  const [strength, setStrength] = useState(80)
  const [title, setTitle] = useState('')
  const [sourceReliability, setSourceReliability] = useState(75)
  const [industryRelevance, setIndustryRelevance] = useState(70)
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    setSaving(true)
    try {
      await api('/api/signals', {
        method: 'POST',
        body: JSON.stringify({ workspaceId, prospectId, type, strength, title, sourceReliability, industryRelevance })
      })
      toast.success('Signal added — prospect rescored')
      onDone()
    } catch (e: unknown) { toast.error((e as Error).message) }
    finally { setSaving(false) }
  }

  return (
    <div style={{ ...s.card, marginTop: 8 }}>
      <div style={{ ...s.sectionHeader, marginBottom: 12 }}>Add Signal</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
        <div>
          <label style={s.label}>Signal Type</label>
          <select value={type} onChange={e => setType(e.target.value as SignalType)}
            style={{ ...s.input, height: 40 }}>
            {ALL_SIGNAL_TYPES.map(t => (
              <option key={t} value={t}>{SIGNAL_TYPE_ICONS[t]} {SIGNAL_TYPE_LABELS[t]}</option>
            ))}
          </select>
        </div>
        <div>
          <label style={s.label}>Strength (0–100)</label>
          <input type="number" min={0} max={100} value={strength}
            onChange={e => setStrength(Number(e.target.value))} style={s.input} />
        </div>
        <div>
          <label style={s.label}>Source Reliability</label>
          <input type="number" min={0} max={100} value={sourceReliability}
            onChange={e => setSourceReliability(Number(e.target.value))} style={s.input} />
        </div>
        <div>
          <label style={s.label}>Industry Relevance</label>
          <input type="number" min={0} max={100} value={industryRelevance}
            onChange={e => setIndustryRelevance(Number(e.target.value))} style={s.input} />
        </div>
      </div>
      <div style={{ marginBottom: 8 }}>
        <label style={s.label}>Title (optional)</label>
        <input type="text" value={title} onChange={e => setTitle(e.target.value)}
          placeholder="e.g. Awarded $2M construction contract" style={s.input} />
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={submit} disabled={saving} style={s.btn}>{saving ? 'Adding…' : 'Add Signal'}</button>
        <button onClick={onDone} style={s.btnGhost}>Cancel</button>
      </div>
    </div>
  )
}

function StrategyCardSection({ rec }: { rec: Recommendation }) {
  return (
    <div style={{ background: '#0a1628', border: `1px solid ${colors.blue}33`, borderRadius: 8, padding: 14, marginBottom: 8 }}>
      <div style={{ color: colors.blue, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
        Strategy Card
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
        {rec.predictedNeed && (
          <div style={{ gridColumn: '1 / -1' }}>
            <div style={{ color: colors.textFaint, fontSize: 10 }}>PREDICTED NEED</div>
            <div style={{ color: colors.text, fontSize: 13, fontWeight: 600 }}>{rec.predictedNeed}</div>
          </div>
        )}
        {rec.meetingProbability != null && (
          <div style={s.cardInner}>
            <div style={{ color: colors.textFaint, fontSize: 10 }}>Meeting Probability</div>
            <div style={{ color: colors.green, fontSize: 18, fontWeight: 700 }}>
              {Math.round(rec.meetingProbability * 100)}%
            </div>
          </div>
        )}
        {rec.expectedRevenue != null && (
          <div style={s.cardInner}>
            <div style={{ color: colors.textFaint, fontSize: 10 }}>Expected Revenue</div>
            <div style={{ color: colors.amber, fontSize: 18, fontWeight: 700 }}>
              ${rec.expectedRevenue.toLocaleString()}
            </div>
          </div>
        )}
        {rec.bestContact && (
          <div>
            <div style={{ color: colors.textFaint, fontSize: 10 }}>CONTACT</div>
            <div style={{ color: colors.text, fontSize: 12 }}>{rec.bestContact}</div>
          </div>
        )}
        {rec.bestChannel && (
          <div>
            <div style={{ color: colors.textFaint, fontSize: 10 }}>CHANNEL</div>
            <div style={{ color: colors.text, fontSize: 12 }}>{rec.bestChannel}</div>
          </div>
        )}
        {rec.bestTiming && (
          <div>
            <div style={{ color: colors.textFaint, fontSize: 10 }}>TIMING</div>
            <div style={{ color: colors.text, fontSize: 12 }}>{rec.bestTiming}</div>
          </div>
        )}
        {rec.messageAngle && (
          <div>
            <div style={{ color: colors.textFaint, fontSize: 10 }}>ANGLE</div>
            <div style={{ color: colors.text, fontSize: 12 }}>{rec.messageAngle}</div>
          </div>
        )}
      </div>
      {rec.actionText && (
        <div style={{ color: colors.blueLight, fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{rec.actionText}</div>
      )}
      {rec.reasoning && (
        <div style={{ color: colors.textFaint, fontSize: 11, fontStyle: 'italic' }}>{rec.reasoning}</div>
      )}
    </div>
  )
}

function ProspectDetail({ prospect, api, toast, onClose, onRefresh }: {
  prospect: Prospect; api: ApiHook; toast: ToastHook; onClose: () => void; onRefresh: () => void
}) {
  const [detail, setDetail] = useState<Prospect | null>(null)
  const [showAddSignal, setShowAddSignal] = useState(false)
  const [loading, setLoading] = useState(true)
  const [enriching, setEnriching] = useState(false)

  useEffect(() => {
    api<Prospect>(`/api/prospects/${prospect.id}`)
      .then(setDetail)
      .catch(e => toast.error(e.message))
      .finally(() => setLoading(false))
  }, [prospect.id])

  const handleRescore = async () => {
    try {
      const updated = await api<Prospect>(`/api/prospects/${prospect.id}/rescore`, { method: 'POST' })
      setDetail(updated)
      onRefresh()
      toast.success(`Rescored: ${updated.opportunityScore}`)
    } catch (e: unknown) { toast.error((e as Error).message) }
  }

  const handleRecommend = async () => {
    try {
      await api<Recommendation>(`/api/prospects/${prospect.id}/recommend`, { method: 'POST' })
      const updated = await api<Prospect>(`/api/prospects/${prospect.id}`)
      setDetail(updated)
      toast.success('Strategy card generated')
    } catch (e: unknown) { toast.error((e as Error).message) }
  }

  const handleEnrich = async () => {
    setEnriching(true)
    try {
      const updated = await api<Prospect>(`/api/prospects/${prospect.id}/enrich`, { method: 'POST' })
      setDetail(updated)
      onRefresh()
      toast.success('Prospect enriched with Apollo data')
    } catch (e: unknown) { toast.error((e as Error).message) }
    finally { setEnriching(false) }
  }

  const p = detail ?? prospect
  const tier = p.opportunityScore >= 72 ? 'HOT' : p.opportunityScore >= 45 ? 'WARM' : 'COLD'

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
      padding: '40px 20px', zIndex: 100, overflowY: 'auto'
    }} onClick={onClose}>
      <div style={{
        ...s.card, width: '100%', maxWidth: 700,
        border: `1px solid ${TIER_COLOR[tier]}44`, maxHeight: '90vh', overflowY: 'auto'
      }} onClick={e => e.stopPropagation()}>
        {loading ? <div style={{ textAlign: 'center', padding: 40 }}><Spinner /></div> : (
          <>
            {/* Header */}
            <div style={{ ...s.flexBetween, marginBottom: 16 }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                  <h2 style={{ margin: 0, fontSize: 20, color: colors.text }}>{p.companyName}</h2>
                  <span style={{
                    background: TIER_COLOR[tier] + '22', color: TIER_COLOR[tier],
                    fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 99
                  }}>{tier}</span>
                </div>
                <div style={{ color: colors.textFaint, fontSize: 13 }}>
                  {[p.industry, p.location].filter(Boolean).join(' · ')}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ color: TIER_COLOR[tier], fontSize: 36, fontWeight: 800 }}>{p.opportunityScore}</div>
                <div style={{ color: colors.textFaint, fontSize: 11 }}>opportunity score</div>
              </div>
            </div>

            {/* Dual scoring row */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 6, marginBottom: 16 }}>
              {([
                ['Intent', p.intentScore, colors.blue],
                ['Fit', p.fitScore, colors.blue],
                ['Timing', p.timingScore, colors.blue],
                ['Confidence', p.confidenceScore, colors.blue],
              ] as const).map(([label, val]) => (
                <div key={label} style={s.cardInner}>
                  <div style={{ color: colors.textFaint, fontSize: 10 }}>{label}</div>
                  <div style={{ color: val >= 70 ? colors.green : val >= 45 ? colors.amber : colors.textFaint, fontSize: 20, fontWeight: 700 }}>{val}</div>
                </div>
              ))}
              <div style={{ ...s.cardInner, border: `1px solid ${colors.amber}33` }}>
                <div style={{ color: colors.textFaint, fontSize: 10 }}>Exp. Rev Score</div>
                <div style={{ color: colors.amber, fontSize: 20, fontWeight: 700 }}>
                  {p.expectedRevenueScore > 0 ? `$${p.expectedRevenueScore.toLocaleString()}` : '–'}
                </div>
              </div>
              <div style={s.cardInner}>
                <div style={{ color: colors.textFaint, fontSize: 10 }}>Win Prob</div>
                <div style={{ color: colors.green, fontSize: 20, fontWeight: 700 }}>
                  {p.winProbability != null ? `${Math.round(p.winProbability * 100)}%` : '–'}
                </div>
              </div>
            </div>

            {/* Stage badges */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 16 }}>
              <div style={s.cardInner}>
                <div style={{ color: colors.textFaint, fontSize: 10, marginBottom: 4 }}>Buying Stage</div>
                <span style={{
                  background: BUYING_STAGE_COLOR[p.buyingStage as BuyingStage] + '33',
                  color: BUYING_STAGE_COLOR[p.buyingStage as BuyingStage],
                  fontSize: 12, fontWeight: 700, padding: '2px 8px', borderRadius: 99
                }}>{BUYING_STAGE_LABELS[p.buyingStage as BuyingStage]}</span>
              </div>
              <div style={s.cardInner}>
                <div style={{ color: colors.textFaint, fontSize: 10, marginBottom: 4 }}>Pipeline Stage</div>
                <span style={{
                  background: OUTCOME_STAGE_COLOR[p.outcomeStage as OutcomeStage] + '33',
                  color: OUTCOME_STAGE_COLOR[p.outcomeStage as OutcomeStage],
                  fontSize: 12, fontWeight: 700, padding: '2px 8px', borderRadius: 99
                }}>{p.outcomeStage}</span>
              </div>
            </div>

            {/* Contact */}
            {(p.contactName || p.contactEmail) && (
              <div style={{ ...s.cardInner, marginBottom: 16 }}>
                <div style={{ color: colors.textFaint, fontSize: 10, marginBottom: 8 }}>PRIMARY CONTACT</div>
                <div style={{ color: colors.text, fontWeight: 600 }}>{p.contactName}</div>
                {p.contactTitle && <div style={{ color: colors.textFaint, fontSize: 12 }}>{p.contactTitle}</div>}
                {p.contactEmail && <div style={{ color: colors.blueLight, fontSize: 13 }}>{p.contactEmail}</div>}
                {p.contactPhone && <div style={{ color: colors.textMuted, fontSize: 13 }}>{p.contactPhone}</div>}
              </div>
            )}

            {/* Top strategy card */}
            {(p.recommendations ?? []).length > 0 && (
              <StrategyCardSection rec={p.recommendations![0]} />
            )}

            {/* Signals */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ ...s.flexBetween, marginBottom: 8 }}>
                <div style={s.sectionHeader}>Signals ({p.signals?.length ?? 0})</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button style={s.btnSm} onClick={handleEnrich} disabled={enriching}>
                    {enriching ? 'Enriching…' : 'Enrich'}
                  </button>
                  <button style={s.btnSm} onClick={handleRescore}>Rescore</button>
                  <button style={s.btnSm} onClick={() => setShowAddSignal(true)}>+ Signal</button>
                </div>
              </div>
              {showAddSignal && (
                <AddSignalForm
                  prospectId={p.id}
                  workspaceId={p.workspaceId}
                  api={api} toast={toast}
                  onDone={() => {
                    setShowAddSignal(false)
                    api<Prospect>(`/api/prospects/${p.id}`).then(setDetail)
                    onRefresh()
                  }}
                />
              )}
              <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
                {(p.signals ?? []).map(sig => <SignalBadge key={sig.id} signal={sig} />)}
                {(p.signals?.length ?? 0) === 0 && (
                  <div style={{ color: colors.textFaint, fontSize: 13 }}>No signals yet. Add a signal to trigger scoring.</div>
                )}
              </div>
            </div>

            {/* All recommendations */}
            {(p.recommendations ?? []).length > 1 && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ ...s.flexBetween, marginBottom: 8 }}>
                  <div style={s.sectionHeader}>All Recommendations</div>
                  <button style={s.btnSm} onClick={handleRecommend}>Generate</button>
                </div>
                {(p.recommendations ?? []).slice(1, 4).map(rec => (
                  <div key={rec.id} style={{ ...s.cardInner, marginBottom: 8 }}>
                    <div style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
                      {rec.bestChannel && <span style={{ color: colors.text, fontSize: 12, fontWeight: 600 }}>{rec.bestChannel}</span>}
                      <span style={{
                        color: rec.urgency === 'HIGH' ? colors.red : rec.urgency === 'MEDIUM' ? colors.amber : colors.textFaint,
                        fontSize: 11, fontWeight: 700
                      }}>{rec.urgency}</span>
                    </div>
                    {rec.actionText && <div style={{ color: colors.blueLight, fontSize: 13 }}>{rec.actionText}</div>}
                    {rec.reasoning && <div style={{ color: colors.textFaint, fontSize: 11, marginTop: 4 }}>{rec.reasoning}</div>}
                  </div>
                ))}
              </div>
            )}

            {(p.recommendations?.length ?? 0) === 0 && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ ...s.flexBetween, marginBottom: 8 }}>
                  <div style={s.sectionHeader}>Strategy Card</div>
                  <button style={s.btnSm} onClick={handleRecommend}>Generate</button>
                </div>
                <div style={{ color: colors.textFaint, fontSize: 13 }}>No strategy card yet. Click Generate to create one.</div>
              </div>
            )}

            <div style={{ display: 'flex', gap: 8 }}>
              <button style={s.btnGhost} onClick={onClose}>Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

const BLANK: Partial<Prospect> & { companyName: string } = {
  companyName: '', industry: '', location: '', domain: '',
  contactName: '', contactEmail: '', contactPhone: '', contactTitle: '',
  expectedDealValue: undefined
}

export function ProspectsView({ api, workspace, toast }: Props) {
  const [prospects, setProspects] = useState<Prospect[]>([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<Prospect | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [form, setForm] = useState(BLANK)
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState<SortBy>('opportunityScore')

  const load = () => {
    if (!workspace) return
    setLoading(true)
    api<{ prospects: Prospect[]; total: number }>(
      `/api/prospects?workspaceId=${workspace.id}&limit=100&sortBy=${sortBy}${search ? `&search=${encodeURIComponent(search)}` : ''}`
    )
      .then(d => setProspects(d.prospects))
      .catch(e => toast.error(e.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [workspace?.id, search, sortBy])

  const handleAdd = async () => {
    if (!workspace || !form.companyName.trim()) return
    setSaving(true)
    try {
      await api<Prospect>('/api/prospects', {
        method: 'POST',
        body: JSON.stringify({ ...form, workspaceId: workspace.id })
      })
      toast.success('Prospect added')
      setShowAdd(false)
      setForm(BLANK)
      load()
    } catch (e: unknown) { toast.error((e as Error).message) }
    finally { setSaving(false) }
  }

  if (!workspace) return <div style={s.card}><EmptyState message="No workspace selected" icon="◎" /></div>

  return (
    <div style={s.stack}>
      {/* Header */}
      <div style={s.flexBetween}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="text" placeholder="Search prospects…" value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ ...s.input, width: 220 }}
          />
          {/* Sort toggle */}
          <div style={{ display: 'flex', background: '#1e2d40', borderRadius: 6, padding: 3, gap: 2 }}>
            <button
              onClick={() => setSortBy('opportunityScore')}
              style={{
                ...s.btnSm, fontSize: 11, padding: '4px 10px',
                background: sortBy === 'opportunityScore' ? colors.blue : 'transparent',
                color: sortBy === 'opportunityScore' ? '#fff' : colors.textMuted,
              }}>
              Score
            </button>
            <button
              onClick={() => setSortBy('expectedRevenueScore')}
              style={{
                ...s.btnSm, fontSize: 11, padding: '4px 10px',
                background: sortBy === 'expectedRevenueScore' ? colors.amber : 'transparent',
                color: sortBy === 'expectedRevenueScore' ? '#000' : colors.textMuted,
              }}>
              $Exp. Revenue
            </button>
          </div>
        </div>
        <button style={s.btn} onClick={() => setShowAdd(true)}>+ Add Prospect</button>
      </div>

      {/* Add form */}
      {showAdd && (
        <div style={s.card}>
          <div style={{ ...s.sectionHeader, marginBottom: 14 }}>New Prospect</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
            {[
              { k: 'companyName', label: 'Company Name *', placeholder: 'Acme Corp' },
              { k: 'industry', label: 'Industry', placeholder: 'Construction' },
              { k: 'location', label: 'Location', placeholder: 'Sydney, AU' },
              { k: 'domain', label: 'Website', placeholder: 'acmecorp.com' },
              { k: 'contactName', label: 'Contact Name', placeholder: 'Jane Smith' },
              { k: 'contactTitle', label: 'Contact Title', placeholder: 'CEO' },
              { k: 'contactEmail', label: 'Contact Email', placeholder: 'jane@acmecorp.com' },
              { k: 'contactPhone', label: 'Contact Phone', placeholder: '+1 555 1234' },
            ].map(({ k, label, placeholder }) => (
              <div key={k}>
                <label style={s.label}>{label}</label>
                <input
                  type="text"
                  value={(form as Record<string, unknown>)[k] as string ?? ''}
                  onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))}
                  placeholder={placeholder}
                  style={s.input}
                />
              </div>
            ))}
          </div>
          <div style={{ marginBottom: 10 }}>
            <label style={s.label}>Expected Deal Value ($)</label>
            <input type="number" value={form.expectedDealValue ?? ''}
              onChange={e => setForm(f => ({ ...f, expectedDealValue: e.target.value ? Number(e.target.value) : undefined }))}
              placeholder="10000" style={{ ...s.input, width: 180 }} />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={handleAdd} disabled={saving || !form.companyName.trim()} style={s.btn}>
              {saving ? 'Saving…' : 'Add Prospect'}
            </button>
            <button onClick={() => { setShowAdd(false); setForm(BLANK) }} style={s.btnGhost}>Cancel</button>
          </div>
        </div>
      )}

      {/* Prospect list */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 40 }}><Spinner /></div>
      ) : prospects.length === 0 ? (
        <div style={s.card}>
          <EmptyState message="No prospects yet. Add your first prospect to start tracking signals." icon="◎" />
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {[
                  { h: 'Company', key: null },
                  { h: 'Industry', key: null },
                  { h: 'Location', key: null },
                  { h: 'Buying Stage', key: null },
                  { h: 'Opp. Score', key: 'opportunityScore' as SortBy },
                  { h: 'Exp. Revenue', key: 'expectedRevenueScore' as SortBy },
                  { h: 'Signals', key: null },
                  { h: 'Win Prob', key: null },
                ].map(({ h, key }) => (
                  <th key={h}
                    onClick={key ? () => setSortBy(key) : undefined}
                    style={{
                      color: key && sortBy === key ? colors.amber : colors.textFaint,
                      fontSize: 11, fontWeight: 600,
                      textTransform: 'uppercase', letterSpacing: '0.06em',
                      padding: '8px 12px 8px 0', textAlign: 'left', whiteSpace: 'nowrap',
                      cursor: key ? 'pointer' : 'default'
                    }}>
                    {h}{key && sortBy === key ? ' ▼' : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {prospects.map(p => {
                const tier = p.opportunityScore >= 72 ? 'HOT' : p.opportunityScore >= 45 ? 'WARM' : 'COLD'
                return (
                  <tr key={p.id}
                    onClick={() => setSelected(p)}
                    style={{ cursor: 'pointer', borderBottom: `1px solid ${colors.borderLight}` }}
                    onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = '#0f172a'}
                    onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}
                  >
                    <td style={{ padding: '10px 12px 10px 0', color: colors.text, fontSize: 14, fontWeight: 600 }}>
                      {p.companyName}
                    </td>
                    <td style={{ padding: '10px 12px 10px 0', color: colors.textFaint, fontSize: 13 }}>
                      {p.industry || '–'}
                    </td>
                    <td style={{ padding: '10px 12px 10px 0', color: colors.textFaint, fontSize: 13 }}>
                      {p.location || '–'}
                    </td>
                    <td style={{ padding: '10px 12px 10px 0' }}>
                      <span style={{
                        background: BUYING_STAGE_COLOR[p.buyingStage as BuyingStage] + '33',
                        color: BUYING_STAGE_COLOR[p.buyingStage as BuyingStage],
                        fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 99
                      }}>{BUYING_STAGE_LABELS[p.buyingStage as BuyingStage]}</span>
                    </td>
                    <td style={{ padding: '10px 12px 10px 0' }}>
                      <span style={{
                        color: TIER_COLOR[tier], fontWeight: 800, fontSize: 16,
                        opacity: sortBy === 'opportunityScore' ? 1 : 0.5
                      }}>
                        {p.opportunityScore}
                      </span>
                    </td>
                    <td style={{ padding: '10px 12px 10px 0' }}>
                      <span style={{
                        color: colors.amber, fontWeight: 700, fontSize: 13,
                        opacity: sortBy === 'expectedRevenueScore' ? 1 : 0.6
                      }}>
                        {p.expectedRevenueScore > 0 ? `$${p.expectedRevenueScore.toLocaleString()}` : '–'}
                      </span>
                    </td>
                    <td style={{ padding: '10px 12px 10px 0', color: colors.textMuted, fontSize: 13 }}>
                      {p.signalCount ?? 0}
                    </td>
                    <td style={{ padding: '10px 12px 10px 0', color: colors.green, fontSize: 13, fontWeight: 600 }}>
                      {p.winProbability != null ? `${Math.round(p.winProbability * 100)}%` : '–'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <ProspectDetail
          prospect={selected}
          api={api} toast={toast}
          onClose={() => setSelected(null)}
          onRefresh={load}
        />
      )}
    </div>
  )
}
