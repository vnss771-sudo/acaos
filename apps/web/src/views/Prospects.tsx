import React, { useEffect, useState, useCallback, useMemo } from 'react'
import { useEscapeKey } from '../hooks/useEscapeKey.js'
import { makeRouteApi } from '../lib/routeApi.js'
import type { Workspace, Prospect, Signal, DiscoveryRun } from '../types.js'
import {
  BUYING_STAGE_COLOR, BUYING_STAGE_LABELS, OUTCOME_STAGE_COLOR,
  SIGNAL_TYPE_ICONS, SIGNAL_TYPE_LABELS, TIER_COLOR
} from '../types.js'
import type { SignalType, BuyingStage, OutcomeStage } from '../types.js'
import { s, colors } from '../styles.js'
import { Spinner, EmptyState } from '../components/Spinner.js'
import type { ApiHook } from '../hooks/useApi.js'
import type { ToastHook } from '../hooks/useToast.js'

type Props = { api: ApiHook; workspace: Workspace | null; toast: ToastHook; canManage?: boolean }

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')

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
  const route = useMemo(() => makeRouteApi(api), [api])
  const [type, setType] = useState<SignalType>('HIRING')
  const [strength, setStrength] = useState(70)
  const [title, setTitle] = useState('')
  const [sourceReliability, setSourceReliability] = useState(70)
  const [industryRelevance, setIndustryRelevance] = useState(60)
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    setSaving(true)
    try {
      await route('POST /api/signals', {
        body: { workspaceId, prospectId, type, strength, title, sourceReliability, industryRelevance }
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
          <label style={s.label} htmlFor="prospects-field-0">Signal Type</label>
          <select id="prospects-field-0" value={type} onChange={e => setType(e.target.value as SignalType)}
            style={{ ...s.input, height: 40 }}>
            {SIGNAL_TYPES.map(t => <option key={t} value={t}>{SIGNAL_TYPE_LABELS[t]}</option>)}
          </select>
        </div>
        <div>
          <label style={s.label} htmlFor="prospects-field-1">Strength (0–100)</label>
          <input id="prospects-field-1" type="number" min={0} max={100} value={strength}
            onChange={e => setStrength(Number(e.target.value))} style={s.input} />
        </div>
        <div>
          <label style={s.label} htmlFor="prospects-field-2">Source Reliability</label>
          <input id="prospects-field-2" type="number" min={0} max={100} value={sourceReliability}
            onChange={e => setSourceReliability(Number(e.target.value))} style={s.input} />
        </div>
        <div>
          <label style={s.label} htmlFor="prospects-field-3">Industry Relevance</label>
          <input id="prospects-field-3" type="number" min={0} max={100} value={industryRelevance}
            onChange={e => setIndustryRelevance(Number(e.target.value))} style={s.input} />
        </div>
      </div>
      <div style={{ marginBottom: 8 }}>
        <label style={s.label} htmlFor="prospects-field-4">Title (optional)</label>
        <input id="prospects-field-4" type="text" value={title} onChange={e => setTitle(e.target.value)}
          placeholder="e.g. Hiring 5 sales reps" style={s.input} />
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={submit} disabled={saving} style={s.btn}>{saving ? 'Adding…' : 'Add Signal'}</button>
        <button onClick={onDone} style={s.btnGhost}>Cancel</button>
      </div>
    </div>
  )
}

function ProspectDetail({ prospect, api, toast, onClose, onRefresh, canManage = false }: {
  prospect: Prospect; api: ApiHook; toast: ToastHook; onClose: () => void; onRefresh: () => void; canManage?: boolean
}) {
  const route = useMemo(() => makeRouteApi(api), [api])
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
      const updated = await route('POST /api/prospects/:id/rescore', { params: { id: prospect.id } }) as Prospect
      setDetail(updated)
      onRefresh()
      toast.success(`Rescored: ${updated.opportunityScore}`)
    } catch (e: unknown) { toast.error((e as Error).message) }
  }

  const handleRecommend = async () => {
    try {
      await route('POST /api/prospects/:id/recommend', { params: { id: prospect.id } })
      const updated = await api<Prospect>(`/api/prospects/${prospect.id}`)
      setDetail(updated)
      toast.success('Recommendation generated')
    } catch (e: unknown) { toast.error((e as Error).message) }
  }

  const handleEnrich = async () => {
    try {
      const result = await route('POST /api/prospects/:id/enrich', { params: { id: prospect.id } })
      const updated = await api<Prospect>(`/api/prospects/${prospect.id}`)
      setDetail(updated)
      onRefresh()
      toast.success(result.signalsCreated > 0
        ? `Apollo enriched — ${result.signalsCreated} new signal${result.signalsCreated !== 1 ? 's' : ''} added`
        : 'Apollo enriched — no new signals found')
    } catch (e: unknown) { toast.error((e as Error).message) }
  }

  const p = detail ?? prospect
  const tier = p.opportunityScore >= 72 ? 'HOT' : p.opportunityScore >= 45 ? 'WARM' : 'COLD'
  useEscapeKey(onClose)

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
      padding: '40px 20px', zIndex: 100, overflowY: 'auto'
    }} onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={`${p.companyName} details`} style={{
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
                  {canManage && <button style={s.btnSm} onClick={() => setShowAddSignal(true)}>+ Signal</button>}
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

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button style={s.btnSm} onClick={handleRescore}>Rescore</button>
              {canManage && (
                <button style={{ ...s.btnSm, background: '#1d4ed8', color: '#fff' }} onClick={handleEnrich} title="Pull signals from Apollo.io">
                  ⚡ Enrich with Apollo
                </button>
              )}
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

function parseCsvLine(line: string): string[] {
  const fields: string[] = []
  let cur = '', inQuote = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++ }
      else if (ch === '"') inQuote = false
      else cur += ch
    } else {
      if (ch === '"') inQuote = true
      else if (ch === ',') { fields.push(cur); cur = '' }
      else cur += ch
    }
  }
  fields.push(cur)
  return fields
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/)
  if (lines.length < 2) return []
  const headers = parseCsvLine(lines[0]).map(h => h.trim())
  return lines.slice(1).map(line => {
    const vals = parseCsvLine(line).map(v => v.trim())
    const row: Record<string, string> = {}
    headers.forEach((h, i) => { if (vals[i] !== undefined) row[h] = vals[i] })
    return row
  }).filter(row => Object.values(row).some(v => v !== ''))
}

export function ProspectsView({ api, workspace, toast, canManage = false }: Props) {
  const route = useMemo(() => makeRouteApi(api), [api])
  const [prospects, setProspects] = useState<Prospect[]>([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<Prospect | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [form, setForm] = useState(BLANK)
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')
  const [importing, setImporting] = useState(false)
  const [discovering, setDiscovering] = useState(false)
  const [discoverSources, setDiscoverSources] = useState<{ name: string; label: string }[]>([])
  const [runs, setRuns] = useState<DiscoveryRun[]>([])
  const [showRuns, setShowRuns] = useState(false)
  const [missions, setMissions] = useState<{ id: string; name: string }[]>([])
  // Optionally attribute discovered prospects to a mission (empty = unscoped).
  const [discoverMissionId, setDiscoverMissionId] = useState('')

  useEffect(() => {
    if (!workspace || !canManage) {
      setDiscoverSources([])
      return
    }
    let cancelled = false
    api<{ sources: { name: string; label: string; isConfigured: boolean }[] }>('/api/prospects/sources')
      .then(d => {
        if (!cancelled) {
          setDiscoverSources(d.sources.filter(s => s.name !== 'csv' && s.isConfigured))
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [api, canManage, workspace?.id])

  useEffect(() => {
    if (!workspace) return
    api<{ missions: { id: string; name: string; status: string }[] }>(`/api/missions?workspaceId=${workspace.id}`)
      .then(d => setMissions((d.missions || []).filter(m => m.status !== 'COMPLETE').map(m => ({ id: m.id, name: m.name }))))
      .catch(() => {})
  }, [workspace?.id])

  const loadRuns = useCallback(() => {
    if (!workspace) return
    api<{ runs: DiscoveryRun[] }>(`/api/prospects/discovery-runs?workspaceId=${workspace.id}`)
      .then(d => setRuns(d.runs || []))
      .catch(() => {})
  }, [api, workspace?.id])

  useEffect(() => { loadRuns() }, [workspace?.id])

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

  // Guard against out-of-order responses: when the user types quickly, a slow
  // earlier request must not overwrite the results of a later one. The cleanup
  // flag drops any response from a superseded effect run.
  useEffect(() => {
    if (!workspace) return
    let cancelled = false
    setLoading(true)
    api<{ prospects: Prospect[]; total: number }>(
      `/api/prospects?workspaceId=${workspace.id}&limit=100${search ? `&search=${encodeURIComponent(search)}` : ''}`
    )
      .then(d => { if (!cancelled) setProspects(d.prospects) })
      .catch(e => { if (!cancelled) toast.error(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [workspace?.id, search])

  const handleAdd = async () => {
    if (!workspace || !form.companyName.trim()) return
    setSaving(true)
    try {
      await route('POST /api/prospects', { body: { ...form, workspaceId: workspace.id } })
      toast.success('Prospect added')
      setShowAdd(false)
      setForm(BLANK)
      load()
    } catch (e: unknown) { toast.error((e as Error).message) }
    finally { setSaving(false) }
  }

  const handleDiscover = async (sourceName = 'apollo') => {
    if (!workspace || discovering) return
    setDiscovering(true)
    try {
      const res = await route('POST /api/prospects/discover', {
        body: { workspaceId: workspace.id, source: sourceName, ...(discoverMissionId ? { missionId: discoverMissionId } : {}) }
      })
      if (res.discovered === 0 && res.total === 0) {
        toast.error('No results — try broadening your ICP settings')
      } else {
        toast.success(
          `Found ${res.discovered} new prospect${res.discovered !== 1 ? 's' : ''}` +
          (res.skipped ? ` · ${res.skipped} already tracked` : '')
        )
        if (res.discovered > 0) load()
      }
    } catch (e: unknown) { toast.error((e as Error).message) }
    finally { setDiscovering(false); loadRuns() }
  }

  const handleImportCsv = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !workspace) return
    setImporting(true)
    const reader = new FileReader()
    reader.onload = async (ev) => {
      try {
        const text = ev.target?.result as string
        const rows = parseCsv(text)
        if (rows.length === 0) { toast.error('No valid rows found in CSV'); return }
        const res = await route('POST /api/prospects/import', {
          body: { workspaceId: workspace.id, rows }
        })
        toast.success(`Imported ${res.imported} prospect${res.imported !== 1 ? 's' : ''}${res.skipped ? `, ${res.skipped} skipped` : ''}${res.failed ? `, ${res.failed} failed` : ''}`)
        load()
      } catch (err: unknown) { toast.error((err as Error).message) }
      finally { setImporting(false) }
    }
    reader.readAsText(file)
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
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {canManage && (<>
          <button style={s.btnSm} onClick={() => {
            const url = `${API_BASE}/api/prospects/export?workspaceId=${workspace.id}`
            const link = document.createElement('a')
            link.href = url
            link.setAttribute('download', `prospects-${new Date().toISOString().slice(0, 10)}.csv`)
            document.body.appendChild(link)
            link.click()
            document.body.removeChild(link)
          }}>
            ↓ Export CSV
          </button>
          <label style={{
            ...s.btnSm,
            cursor: importing ? 'wait' : 'pointer',
            opacity: importing ? 0.6 : 1,
            display: 'inline-flex', alignItems: 'center'
          }}>
            {importing ? 'Importing…' : '↑ Import CSV'}
            <input
              type="file" accept=".csv,text/csv" style={{ display: 'none' }}
              onChange={handleImportCsv} disabled={importing}
            />
          </label>
          {discoverSources.length > 0 && missions.length > 0 && (
            <select
              value={discoverMissionId}
              onChange={e => setDiscoverMissionId(e.target.value)}
              disabled={discovering}
              style={{ ...s.input, width: 180 }}
              title="Attribute discovered prospects to a mission"
            >
              <option value="">No mission</option>
              {missions.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          )}
          {discoverSources.map(src => (
            <button
              key={src.name}
              style={{
                ...s.btn,
                background: discovering ? '#1e3a5f' : '#1d4ed8',
                opacity: discovering ? 0.8 : 1,
              }}
              onClick={() => handleDiscover(src.name)}
              disabled={discovering}
              title={`Search ${src.label} for companies matching your ICP`}
            >
              {discovering ? `⟳ Searching…` : `⚡ ${src.label}`}
            </button>
          ))}
          <button style={s.btn} onClick={() => setShowAdd(true)}>+ Add Prospect</button>
          </>)}
        </div>
      </div>

      {/* Discovery run history — lets users see provider failures vs. "no results" */}
      {runs.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <button
            onClick={() => setShowRuns(v => !v)}
            style={{ background: 'none', border: 'none', color: colors.textMuted, cursor: 'pointer', fontSize: 12, padding: 0 }}
          >
            {showRuns ? '▾' : '▸'} Discovery history ({runs.length})
            {runs.some(r => r.status === 'FAILED') && <span style={{ color: colors.red, marginLeft: 6 }}>· has failures</span>}
          </button>
          {showRuns && (
            <div style={{ ...s.card, marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {runs.map(r => {
                const color = r.status === 'SUCCEEDED' ? colors.green : r.status === 'FAILED' ? colors.red : colors.amber
                return (
                  <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, borderBottom: `1px solid ${colors.border}`, paddingBottom: 6 }}>
                    <span style={{ color, fontWeight: 700, minWidth: 76 }}>{r.status}</span>
                    <span style={{ color: colors.textMuted, minWidth: 90 }}>{r.source}</span>
                    {r.status === 'FAILED'
                      ? <span style={{ color: colors.red, flex: 1 }}>{r.errorMessage || r.errorCode || 'provider error'}</span>
                      : <span style={{ color: colors.textFaint, flex: 1 }}>{r.importedCount} imported · {r.skippedCount} skipped · {r.resultCount} found</span>}
                    <span style={{ color: colors.textFaint }}>{new Date(r.startedAt).toLocaleString()}</span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

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
                <label style={s.label} htmlFor="prospects-field-5">{label}</label>
                <input id="prospects-field-5"
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
            <label style={s.label} htmlFor="prospects-field-6">Expected Deal Value ($)</label>
            <input id="prospects-field-6" type="number" value={form.expectedDealValue ?? ''}
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
                      {p.isExample && (
                        <span style={{
                          marginLeft: 6, background: '#64748b22', color: '#94a3b8',
                          fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 99, letterSpacing: '0.06em',
                          verticalAlign: 'middle'
                        }}>EXAMPLE</span>
                      )}
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
          canManage={canManage}
        />
      )}
    </div>
  )
}
