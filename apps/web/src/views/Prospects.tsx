import React, { useEffect, useState } from 'react'
import type { Workspace, Prospect, Signal, Recommendation } from '../types.js'
import {
  BUYING_STAGE_COLOR, BUYING_STAGE_LABELS, OUTCOME_STAGE_COLOR,
  SIGNAL_TYPE_ICONS, SIGNAL_TYPE_LABELS, TIER_COLOR, getScoreTier
} from '../types.js'
import type { SignalType, BuyingStage, OutcomeStage } from '../types.js'
import { s, colors } from '../styles.js'
import { Spinner, EmptyState } from '../components/Spinner.js'
import type { ApiHook } from '../hooks/useApi.js'
import type { ToastHook } from '../hooks/useToast.js'

type Props = { api: ApiHook; workspace: Workspace | null; toast: ToastHook }

const SIGNAL_TYPES: SignalType[] = [
  'HIRING', 'FUNDING', 'EXPANSION', 'TECH_ADOPTION', 'LEADERSHIP_CHANGE',
  'NEWS_MENTION', 'PROCUREMENT', 'BUSINESS_REGISTRATION', 'WEBSITE_CHANGE'
]

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
  const [type, setType] = useState<SignalType>('HIRING')
  const [strength, setStrength] = useState(70)
  const [title, setTitle] = useState('')
  const [sourceReliability, setSourceReliability] = useState(70)
  const [industryRelevance, setIndustryRelevance] = useState(60)
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
            {SIGNAL_TYPES.map(t => <option key={t} value={t}>{SIGNAL_TYPE_LABELS[t]}</option>)}
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
          placeholder="e.g. Hiring 5 sales reps" style={s.input} />
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={submit} disabled={saving} style={s.btn}>{saving ? 'Adding…' : 'Add Signal'}</button>
        <button onClick={onDone} style={s.btnGhost}>Cancel</button>
      </div>
    </div>
  )
}

function ProspectDetail({ prospect, api, toast, onClose, onRefresh }: {
  prospect: Prospect; api: ApiHook; toast: ToastHook; onClose: () => void; onRefresh: () => void
}) {
  const [detail, setDetail] = useState<Prospect | null>(null)
  const [showAddSignal, setShowAddSignal] = useState(false)
  const [loading, setLoading] = useState(true)

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
      toast.success('Recommendation generated')
    } catch (e: unknown) { toast.error((e as Error).message) }
  }

  const p = detail ?? prospect
  const tier = getScoreTier(p.opportunityScore)

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
      padding: '40px 20px', zIndex: 100, overflowY: 'auto'
    }} onClick={onClose}>
      <div style={{
        ...s.card, width: '100%', maxWidth: 680,
        border: `1px solid ${TIER_COLOR[tier]}44`, maxHeight: '85vh', overflowY: 'auto'
      }} onClick={e => e.stopPropagation()}>
        {loading ? <div style={{ textAlign: 'center', padding: 40 }}><Spinner /></div> : (
          <>
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

            {/* Score sub-dimensions */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 16 }}>
              {([['Intent', p.intentScore], ['Fit', p.fitScore], ['Timing', p.timingScore], ['Confidence', p.confidenceScore]] as const).map(([label, val]) => (
                <div key={label} style={s.cardInner}>
                  <div style={{ color: colors.textFaint, fontSize: 10 }}>{label}</div>
                  <div style={{ color: val >= 70 ? colors.green : val >= 45 ? colors.amber : colors.textFaint, fontSize: 22, fontWeight: 700 }}>{val}</div>
                </div>
              ))}
            </div>

            {/* Buying stage + outcome */}
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

            {/* Signals */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ ...s.flexBetween, marginBottom: 8 }}>
                <div style={s.sectionHeader}>Signals ({p.signals?.length ?? 0})</div>
                <div style={{ display: 'flex', gap: 6 }}>
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

            {/* Recommendations */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ ...s.flexBetween, marginBottom: 8 }}>
                <div style={s.sectionHeader}>Recommendations</div>
                <button style={s.btnSm} onClick={handleRecommend}>Generate</button>
              </div>
              {(p.recommendations ?? []).slice(0, 3).map(rec => (
                <div key={rec.id} style={{ ...s.cardInner, marginBottom: 8 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 6 }}>
                    {rec.bestContact && <div><span style={{ color: colors.textFaint, fontSize: 10 }}>CONTACT </span><span style={{ color: colors.text, fontSize: 12 }}>{rec.bestContact}</span></div>}
                    {rec.bestChannel && <div><span style={{ color: colors.textFaint, fontSize: 10 }}>CHANNEL </span><span style={{ color: colors.text, fontSize: 12 }}>{rec.bestChannel}</span></div>}
                    {rec.bestTiming && <div><span style={{ color: colors.textFaint, fontSize: 10 }}>TIMING </span><span style={{ color: colors.text, fontSize: 12 }}>{rec.bestTiming}</span></div>}
                    {rec.messageAngle && <div><span style={{ color: colors.textFaint, fontSize: 10 }}>ANGLE </span><span style={{ color: colors.text, fontSize: 12 }}>{rec.messageAngle}</span></div>}
                  </div>
                  {rec.actionText && <div style={{ color: colors.blueLight, fontSize: 13, fontWeight: 600 }}>{rec.actionText}</div>}
                  {rec.reasoning && <div style={{ color: colors.textFaint, fontSize: 11, marginTop: 4 }}>{rec.reasoning}</div>}
                </div>
              ))}
              {(p.recommendations?.length ?? 0) === 0 && (
                <div style={{ color: colors.textFaint, fontSize: 13 }}>No recommendations yet. Click Generate to create one.</div>
              )}
            </div>

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

  const load = () => {
    if (!workspace) return
    setLoading(true)
    api<{ prospects: Prospect[]; total: number }>(
      `/api/prospects?workspaceId=${workspace.id}&limit=100${search ? `&search=${encodeURIComponent(search)}` : ''}`
    )
      .then(d => setProspects(d.prospects))
      .catch(e => toast.error(e.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [workspace?.id, search])

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
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="text" placeholder="Search prospects…" value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ ...s.input, width: 240 }}
          />
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
                {['Company', 'Industry', 'Location', 'Buying Stage', 'Score', 'Signals', 'Win Prob'].map(h => (
                  <th key={h} style={{
                    color: colors.textFaint, fontSize: 11, fontWeight: 600,
                    textTransform: 'uppercase', letterSpacing: '0.06em',
                    padding: '8px 12px 8px 0', textAlign: 'left', whiteSpace: 'nowrap'
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {prospects.map(p => {
                const tier = getScoreTier(p.opportunityScore)
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
                      <span style={{ color: TIER_COLOR[tier], fontWeight: 800, fontSize: 16 }}>
                        {p.opportunityScore}
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
