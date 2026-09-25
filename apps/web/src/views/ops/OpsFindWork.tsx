import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { OpportunityStatus, UpdateDiscoveryProfileRequest } from '@acaos/shared'
import type { ApiHook } from '../../hooks/useApi.js'
import type { ToastHook } from '../../hooks/useToast.js'
import type { View, Workspace } from '../../types.js'
import { colors, s } from '../../styles.js'
import { makeRouteApi } from '../../lib/routeApi.js'
import { Card } from '../../components/ui/Card.js'
import { Badge } from '../../components/ui/Badge.js'
import { EmptyState } from '../../components/ui/EmptyState.js'
import { ErrorBanner } from '../../components/ui/ErrorBanner.js'
import { Skeleton } from '../../components/ui/Skeleton.js'
import { OpsSubNav } from '../../components/ops/OpsSubNav.js'

// "Find work": jobs the discovery sweep found for this business (government
// contracts a head contractor just won, development applications nearby), each
// with the evidence for why it was surfaced and what to do next. Members work
// the list; admins set what to look for (trades, area, sources).

type Props = { api: ApiHook; workspace: Workspace | null; toast: ToastHook; canManage?: boolean; setView: (v: View) => void }

type Opportunity = {
  id: string
  source: string
  kind: 'CONTRACT_AWARD' | 'DEVELOPMENT_APPLICATION'
  title: string
  description: string | null
  address: string | null
  locality: string | null
  region: string | null
  distanceKm: number | null
  valueAmount: number | null
  publishedAt: string | null
  sourceUrl: string | null
  counterpartyName: string | null
  counterpartyAbn: string | null
  counterpartyEmail: string | null
  counterpartyPhone: string | null
  buyerName: string | null
  score: number
  reasons: string[]
  recommendedAction: string | null
  status: OpportunityStatus
  opsJobSiteId: string | null
}

type ListResponse = { opportunities: Opportunity[]; counts: Partial<Record<OpportunityStatus, number>>; total: number }

type SourceInfo = {
  name: string; label: string; description: string; configured: boolean
  lastRunAt: string | null; lastSuccessAt: string | null; lastError: string | null; lastWarning: string | null; lastMatched: number
}

type Profile = {
  enabled: boolean; trades: string[]; keywords: string[]; baseLat: number | null; baseLng: number | null
  radiusKm: number; regions: string[]; minValue: number | null; sources: string[]
}

type ProfileResponse = {
  profile: Profile | null
  discoveryEnabled: boolean
  trades: { id: string; label: string }[]
  regions: string[]
  sources: SourceInfo[]
}

const KIND_LABEL: Record<Opportunity['kind'], string> = {
  CONTRACT_AWARD: 'Contract awarded',
  DEVELOPMENT_APPLICATION: 'Development application',
}

const FILTERS: { status: OpportunityStatus | null; label: string }[] = [
  { status: null, label: 'Active' },
  { status: 'PURSUING', label: 'Pursuing' },
  { status: 'WON', label: 'Won' },
  { status: 'LOST', label: 'Lost' },
  { status: 'DISMISSED', label: 'Dismissed' },
]

function scoreColor(score: number): string {
  return score >= 70 ? colors.green : score >= 50 ? colors.amber : colors.textFaint
}

function formatValue(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `$${Math.round(n / 1_000)}k`
  return `$${Math.round(n)}`
}

type ProfileForm = {
  enabled: boolean; trades: string[]; keywords: string; baseLat: string; baseLng: string
  radiusKm: string; regions: string[]; minValue: string; sources: string[]
}

function toForm(p: Profile | null): ProfileForm {
  return {
    enabled: p?.enabled ?? true,
    trades: p?.trades ?? [],
    keywords: (p?.keywords ?? []).join(', '),
    baseLat: p?.baseLat != null ? String(p.baseLat) : '',
    baseLng: p?.baseLng != null ? String(p.baseLng) : '',
    radiusKm: String(p?.radiusKm ?? 50),
    regions: p?.regions ?? [],
    minValue: p?.minValue != null ? String(p.minValue) : '',
    sources: p?.sources ?? ['austender'],
  }
}

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter(v => v !== value) : [...list, value]
}

export function OpsFindWork({ api, workspace, toast, canManage = false, setView }: Props) {
  const route = useMemo(() => makeRouteApi(api), [api])
  const [filter, setFilter] = useState<OpportunityStatus | null>(null)
  const [data, setData] = useState<ListResponse | null>(null)
  const [meta, setMeta] = useState<ProfileResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [form, setForm] = useState<ProfileForm>(toForm(null))
  const [saving, setSaving] = useState(false)

  const reqRef = useRef(0)
  const load = useCallback(() => {
    if (!workspace) return
    const reqId = ++reqRef.current
    setLoading(true)
    setLoadError(false)
    const params = new URLSearchParams({ workspaceId: workspace.id })
    if (filter) params.set('status', filter)
    Promise.all([
      api<ListResponse>(`/api/opportunities?${params}`),
      api<ProfileResponse>(`/api/opportunities/profile?workspaceId=${workspace.id}`),
    ])
      .then(([list, profile]) => {
        if (reqId !== reqRef.current) return
        setData(list)
        setMeta(profile)
      })
      .catch(e => {
        if (reqId !== reqRef.current) return
        toast.error(e instanceof Error ? e.message : 'Failed to load opportunities')
        setLoadError(true)
      })
      .finally(() => { if (reqId === reqRef.current) setLoading(false) })
  }, [workspace?.id, filter])

  useEffect(() => { load() }, [load])

  const openSettings = () => { setForm(toForm(meta?.profile ?? null)); setSettingsOpen(true) }

  async function setStatus(o: Opportunity, status: OpportunityStatus) {
    if (!workspace) return
    setBusyId(o.id)
    try {
      await route('PATCH /api/opportunities/:id/status', { params: { id: o.id }, body: { workspaceId: workspace.id, status } })
      load()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to update') }
    finally { setBusyId(null) }
  }

  async function createJob(o: Opportunity) {
    if (!workspace) return
    setBusyId(o.id)
    try {
      const r = await route('POST /api/opportunities/:id/create-job', { params: { id: o.id }, body: { workspaceId: workspace.id } })
      toast.success(`Job site ${r.jobSite.jobCode} created`)
      load()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to create job site') }
    finally { setBusyId(null) }
  }

  async function runNow() {
    if (!workspace) return
    try {
      await route('POST /api/opportunities/run', { body: { workspaceId: workspace.id } })
      toast.success('Searching now — new work will appear here shortly')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to start search') }
  }

  async function saveProfile() {
    if (!workspace) return
    const lat = form.baseLat.trim(), lng = form.baseLng.trim()
    if ((lat === '') !== (lng === '')) { toast.error('Enter both latitude and longitude, or neither'); return }
    const body: UpdateDiscoveryProfileRequest = {
      workspaceId: workspace.id,
      enabled: form.enabled,
      trades: form.trades,
      keywords: form.keywords.split(',').map(k => k.trim()).filter(k => k.length >= 2),
      baseLat: lat ? Number(lat) : null,
      baseLng: lng ? Number(lng) : null,
      radiusKm: Number(form.radiusKm) || 50,
      regions: form.regions as UpdateDiscoveryProfileRequest['regions'],
      minValue: form.minValue.trim() ? Number(form.minValue) : null,
      sources: form.sources,
    }
    setSaving(true)
    try {
      await route('PUT /api/opportunities/profile', { body })
      toast.success('Discovery settings saved')
      setSettingsOpen(false)
      load()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to save settings') }
    finally { setSaving(false) }
  }

  if (!workspace) return <EmptyState title="No workspace selected" description="Pick a workspace to find work." />

  const profile = meta?.profile ?? null
  const opportunities = data?.opportunities ?? []
  const activeCount = (data?.counts.NEW ?? 0) + (data?.counts.PURSUING ?? 0)

  return (
    <div>
      <OpsSubNav view="ops-find-work" setView={setView} />

      <div style={{ ...s.flexBetween, marginBottom: 12, gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18, color: colors.text }}>Find work</h2>
          <div style={{ color: colors.textFaint, fontSize: 13, marginTop: 4 }}>
            Jobs we found for your trade and area, with the evidence and a suggested next step.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {canManage && profile && <button style={s.btnGhost} onClick={runNow}>Search now</button>}
          <button style={s.btnGhost} onClick={openSettings}>{canManage ? 'Discovery settings' : 'What we look for'}</button>
        </div>
      </div>

      {meta && !meta.discoveryEnabled && (
        <div role="status" style={{ padding: 10, borderRadius: 6, border: `1px solid ${colors.amber}`, color: colors.text, fontSize: 13, marginBottom: 12 }}>
          Automatic searching is switched off on this server, so nothing new will appear until an administrator turns it on.
        </div>
      )}
      {meta?.sources.filter(src => profile?.sources.includes(src.name) && (src.lastError || src.lastWarning)).map(src => (
        <div key={src.name} role="status" style={{ padding: 10, borderRadius: 6, border: `1px solid ${src.lastError ? colors.red : colors.amber}`, color: colors.text, fontSize: 13, marginBottom: 12 }}>
          <strong>{src.label}:</strong> {src.lastError ? `last search failed — ${src.lastError}` : src.lastWarning}
        </div>
      ))}

      {settingsOpen && meta && (
        <Card style={{ marginBottom: 16 }}>
          <div style={{ display: 'grid', gap: 14 }}>
            <fieldset disabled={!canManage} style={{ border: 'none', padding: 0, margin: 0, display: 'grid', gap: 14 }}>
              <div>
                <div style={s.label}>Your trades</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                  {meta.trades.map(t => (
                    <label key={t.id} style={{ fontSize: 13, color: colors.text, display: 'flex', gap: 6, alignItems: 'center' }}>
                      <input type="checkbox" checked={form.trades.includes(t.id)} onChange={() => setForm(f => ({ ...f, trades: toggle(f.trades, t.id) }))} />
                      {t.label}
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <label style={s.label} htmlFor="fw-keywords">Extra keywords (comma separated)</label>
                <input id="fw-keywords" style={s.input} value={form.keywords} placeholder="e.g. switchroom, cool room" onChange={e => setForm(f => ({ ...f, keywords: e.target.value }))} />
              </div>
              <div>
                <div style={s.label}>States you work in</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                  {meta.regions.map(r => (
                    <label key={r} style={{ fontSize: 13, color: colors.text, display: 'flex', gap: 6, alignItems: 'center' }}>
                      <input type="checkbox" checked={form.regions.includes(r)} onChange={() => setForm(f => ({ ...f, regions: toggle(f.regions, r) }))} />
                      {r}
                    </label>
                  ))}
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
                <div>
                  <label style={s.label} htmlFor="fw-lat">Base latitude</label>
                  <input id="fw-lat" type="number" step="any" style={s.input} value={form.baseLat} placeholder="-27.4698" onChange={e => setForm(f => ({ ...f, baseLat: e.target.value }))} />
                </div>
                <div>
                  <label style={s.label} htmlFor="fw-lng">Base longitude</label>
                  <input id="fw-lng" type="number" step="any" style={s.input} value={form.baseLng} placeholder="153.0251" onChange={e => setForm(f => ({ ...f, baseLng: e.target.value }))} />
                </div>
                <div>
                  <label style={s.label} htmlFor="fw-radius">Travel radius (km)</label>
                  <input id="fw-radius" type="number" min={1} max={500} style={s.input} value={form.radiusKm} onChange={e => setForm(f => ({ ...f, radiusKm: e.target.value }))} />
                </div>
                <div>
                  <label style={s.label} htmlFor="fw-min">Smallest contract ($)</label>
                  <input id="fw-min" type="number" min={0} style={s.input} value={form.minValue} placeholder="No minimum" onChange={e => setForm(f => ({ ...f, minValue: e.target.value }))} />
                </div>
              </div>
              <div>
                <div style={s.label}>Where to look</div>
                <div style={{ display: 'grid', gap: 8 }}>
                  {meta.sources.map(src => (
                    <label key={src.name} style={{ fontSize: 13, color: colors.text, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                      <input type="checkbox" checked={form.sources.includes(src.name)} onChange={() => setForm(f => ({ ...f, sources: toggle(f.sources, src.name) }))} />
                      <span>
                        <strong>{src.label}</strong> — {src.description}
                        {!src.configured && <span style={{ color: colors.amber }}> (not set up on this server yet)</span>}
                        {src.lastSuccessAt && <span style={{ color: colors.textFaint }}> · last searched {new Date(src.lastSuccessAt).toLocaleString()}</span>}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
              <label style={{ fontSize: 13, color: colors.text, display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="checkbox" checked={form.enabled} onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))} />
                Search automatically
              </label>
            </fieldset>
            <div style={{ display: 'flex', gap: 8 }}>
              {canManage && <button style={s.btn} onClick={saveProfile} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>}
              <button style={s.btnGhost} onClick={() => setSettingsOpen(false)}>Close</button>
            </div>
          </div>
        </Card>
      )}

      <div role="tablist" aria-label="Filter opportunities" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        {FILTERS.map(f => {
          const count = f.status ? data?.counts[f.status] : activeCount
          const active = filter === f.status
          return (
            <button
              key={f.label}
              role="tab"
              aria-selected={active}
              onClick={() => setFilter(f.status)}
              style={{
                padding: '5px 12px', borderRadius: 999, fontSize: 12, cursor: 'pointer',
                border: `1px solid ${active ? colors.blue : colors.border}`,
                background: active ? colors.blue : 'transparent', color: active ? '#fff' : colors.textMuted,
              }}
            >
              {f.label}{count ? ` (${count})` : ''}
            </button>
          )
        })}
      </div>

      {loadError && !data ? (
        <ErrorBanner message="Failed to load opportunities." onRetry={load} />
      ) : loading && !data ? (
        <div style={{ display: 'grid', gap: 12 }}>{[0, 1, 2].map(i => <Skeleton key={i} height={120} />)}</div>
      ) : !profile ? (
        <EmptyState
          title="Tell us what work you want"
          description="Choose your trades and where you work, and we'll search government contracts and council development applications for jobs you could win."
          action={canManage ? <button style={s.btn} onClick={openSettings}>Set up Find work</button> : undefined}
        />
      ) : opportunities.length === 0 ? (
        <EmptyState
          title={filter ? 'Nothing here yet' : 'No new work found yet'}
          description={filter ? 'Opportunities you move to this stage will show here.' : 'We search on a schedule. New matches for your trades and area will appear here.'}
        />
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {opportunities.map(o => (
            <Card key={o.id} style={{ display: 'grid', gap: 8 }}>
              <div style={{ ...s.flexBetween, gap: 12, alignItems: 'flex-start' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <Badge color={o.kind === 'CONTRACT_AWARD' ? colors.purple : colors.blueLight}>{KIND_LABEL[o.kind]}</Badge>
                    {o.valueAmount != null && <span style={{ color: colors.text, fontWeight: 600, fontSize: 13 }}>{formatValue(o.valueAmount)}</span>}
                    <span style={{ color: colors.textFaint, fontSize: 12 }}>
                      {[o.address ?? [o.locality, o.region].filter(Boolean).join(', '), o.distanceKm != null ? `${Math.round(o.distanceKm)} km away` : null].filter(Boolean).join(' · ')}
                    </span>
                  </div>
                  <div style={{ color: colors.text, fontWeight: 700, fontSize: 15, marginTop: 6 }}>{o.title}</div>
                </div>
                <div title="How well this matches your trades, area, size and timing" style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ color: scoreColor(o.score), fontWeight: 700, fontSize: 20 }}>{o.score}</div>
                  <div style={{ color: colors.textFaint, fontSize: 11 }}>match</div>
                </div>
              </div>

              <ul aria-label="Why this was found" style={{ margin: 0, paddingLeft: 18, color: colors.textMuted, fontSize: 13, display: 'grid', gap: 2 }}>
                {o.reasons.map((r, i) => <li key={i}>{r}</li>)}
              </ul>

              {o.recommendedAction && (
                <div style={{ color: colors.blueLight, fontSize: 13 }}>
                  <span style={{ color: colors.textFaint }}>Next step: </span>{o.recommendedAction}
                </div>
              )}

              {(o.counterpartyName || o.sourceUrl) && (
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 12, color: colors.textMuted }}>
                  {o.counterpartyName && <span>{o.counterpartyName}{o.counterpartyAbn ? ` · ABN ${o.counterpartyAbn}` : ''}</span>}
                  {o.counterpartyPhone && <a href={`tel:${o.counterpartyPhone.replace(/\s+/g, '')}`} style={{ color: colors.blueLight }}>{o.counterpartyPhone}</a>}
                  {o.counterpartyEmail && <a href={`mailto:${o.counterpartyEmail}`} style={{ color: colors.blueLight }}>{o.counterpartyEmail}</a>}
                  {o.sourceUrl && <a href={o.sourceUrl} target="_blank" rel="noopener noreferrer" style={{ color: colors.blueLight }}>View source ↗</a>}
                </div>
              )}

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
                {o.status === 'NEW' && <button style={s.btnSm} disabled={busyId === o.id} onClick={() => setStatus(o, 'PURSUING')}>Pursue</button>}
                {o.status === 'PURSUING' && (
                  <>
                    <button style={s.btnSm} disabled={busyId === o.id} onClick={() => setStatus(o, 'WON')}>Won it</button>
                    <button style={s.btnGhost} disabled={busyId === o.id} onClick={() => setStatus(o, 'LOST')}>Lost it</button>
                  </>
                )}
                {o.status === 'WON' && (o.opsJobSiteId
                  ? <span style={{ color: colors.green, fontSize: 13 }}>✓ Job site created</span>
                  : canManage && <button style={s.btnSm} disabled={busyId === o.id} onClick={() => createJob(o)}>Create job site</button>)}
                {(o.status === 'NEW' || o.status === 'PURSUING') && <button style={s.btnGhost} disabled={busyId === o.id} onClick={() => setStatus(o, 'DISMISSED')}>Not for us</button>}
                {(o.status === 'DISMISSED' || o.status === 'LOST') && <button style={s.btnGhost} disabled={busyId === o.id} onClick={() => setStatus(o, 'NEW')}>Reopen</button>}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
