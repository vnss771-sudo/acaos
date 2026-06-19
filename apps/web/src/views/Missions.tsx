import React, { useEffect, useState, useCallback, useRef } from 'react'
import type { UpdateMissionRequest, DiscoverProspectsRequest } from '@acaos/shared'
import type { Mission, MissionDetail, MissionStatus, Workspace } from '../types.js'
import { s, colors } from '../styles.js'
import { Spinner, EmptyState } from '../components/Spinner.js'
import { MissionBuilder } from '../components/MissionBuilder.js'
import type { ApiHook } from '../hooks/useApi.js'
import type { ToastHook } from '../hooks/useToast.js'

type Props = { api: ApiHook; workspace: Workspace | null; toast: ToastHook; canManage?: boolean }

const STATUS_COLOR: Record<MissionStatus, string> = {
  DRAFT: colors.textFaint,
  DISCOVERING: colors.blue,
  REVIEWING: colors.blue,
  ACTIVE: colors.green,
  PAUSED: colors.amber,
  COMPLETE: colors.textMuted,
}

function StatusBadge({ status }: { status: MissionStatus }) {
  return (
    <span style={{
      fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', padding: '2px 8px',
      borderRadius: 99, color: STATUS_COLOR[status], border: `1px solid ${STATUS_COLOR[status]}55`,
    }}>
      {status}
    </span>
  )
}

export function MissionsView({ api, workspace, toast, canManage = false }: Props) {
  const [missions, setMissions] = useState<Mission[]>([])
  const [loading, setLoading] = useState(true)
  const [showBuilder, setShowBuilder] = useState(false)
  const [busy, setBusy] = useState<Record<string, boolean>>({})

  // Monotonic request id so only the latest load applies (load runs from the
  // effect on workspace change and imperatively after status edits).
  const loadReqRef = useRef(0)
  const load = useCallback(() => {
    if (!workspace) return
    const reqId = ++loadReqRef.current
    setLoading(true)
    api<{ missions: Mission[] }>(`/api/missions?workspaceId=${workspace.id}`)
      .then(d => { if (reqId === loadReqRef.current) setMissions(d.missions || []) })
      .catch(e => { if (reqId === loadReqRef.current) toast.error(e instanceof Error ? e.message : 'Failed to load missions') })
      .finally(() => { if (reqId === loadReqRef.current) setLoading(false) })
  }, [api, workspace?.id, toast])

  useEffect(() => { load() }, [workspace?.id])

  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  async function setStatus(id: string, status: MissionStatus) {
    setBusy(prev => ({ ...prev, [id]: true }))
    try {
      const body: UpdateMissionRequest = { status }
      const d = await api<{ mission: Mission }>(`/api/missions/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
      setMissions(prev => prev.map(m => m.id === id ? d.mission : m))
      toast.success(`Mission ${status.toLowerCase()}`)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Update failed') }
    finally { setBusy(prev => ({ ...prev, [id]: false })) }
  }

  async function discover(id: string) {
    if (!workspace) return
    setBusy(prev => ({ ...prev, [id]: true }))
    try {
      const body: DiscoverProspectsRequest = { workspaceId: workspace.id, missionId: id }
      const d = await api<{ discovered: number; skipped: number; total: number }>('/api/prospects/discover', {
        method: 'POST', body: JSON.stringify(body),
      })
      toast.success(`Discovered ${d.discovered} new prospect${d.discovered !== 1 ? 's' : ''} (${d.skipped} skipped)`)
      load()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Discovery failed') }
    finally { setBusy(prev => ({ ...prev, [id]: false })) }
  }

  if (!workspace) return null
  if (loading) return <Spinner />

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <p style={{ color: colors.textMuted, fontSize: 13, margin: 0 }}>
          A mission ties your target, offer, and outreach into one tracked workflow.
        </p>
        {canManage && <button style={s.btn} onClick={() => setShowBuilder(true)}>+ New Mission</button>}
      </div>

      {missions.length === 0 ? (
        <EmptyState message="No missions yet — launch your first mission to start acquiring customers." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {missions.map(m => {
            const leads = m.campaign?._count?.leads ?? 0
            const isBusy = busy[m.id]
            return (
              <div key={m.id} style={{ ...s.card, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ color: colors.text, fontWeight: 700, fontSize: 15 }}>{m.name}</span>
                    <StatusBadge status={m.status} />
                  </div>
                  <span style={{ color: colors.textMuted, fontSize: 12 }}>{m.goalType.replace(/_/g, ' ')}</span>
                </div>
                {m.targetCustomer && (
                  <div style={{ color: colors.textMuted, fontSize: 13 }}>
                    <strong style={{ color: colors.textFaint }}>Target:</strong> {m.targetCustomer}
                  </div>
                )}
                {m.offer && (
                  <div style={{ color: colors.textMuted, fontSize: 13 }}>
                    <strong style={{ color: colors.textFaint }}>Offer:</strong> {m.offer}
                  </div>
                )}
                {m.stats && (m.stats.sent > 0 || m.stats.failed > 0) && (
                  <div style={{ display: 'flex', gap: 14, fontSize: 12, color: colors.textMuted }}>
                    <span>{m.stats.sent} sent</span>
                    <span style={{ color: colors.green }}>{m.stats.replied} replied</span>
                    {(m.stats.failed + m.stats.bounced) > 0 && (
                      <span style={{ color: colors.red }}>{m.stats.failed + m.stats.bounced} failed/bounced</span>
                    )}
                  </div>
                )}
                {(m.stats?.pendingDrafts ?? 0) > 0 && (
                  <div style={{ fontSize: 12, color: colors.amber }}>
                    ✎ {m.stats!.pendingDrafts} draft{m.stats!.pendingDrafts !== 1 ? 's' : ''} awaiting review
                  </div>
                )}
                {(m.discovery?.runs ?? 0) > 0 && (
                  <div style={{ fontSize: 12, color: colors.textMuted }}>
                    🔍 {m.discovery!.discovered} prospect{m.discovery!.discovered !== 1 ? 's' : ''} discovered
                    {' '}across {m.discovery!.runs} run{m.discovery!.runs !== 1 ? 's' : ''}
                  </div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
                  <span style={{ color: colors.textFaint, fontSize: 12 }}>{leads} lead{leads !== 1 ? 's' : ''} enrolled</span>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      style={{ ...s.btnSm, border: `1px solid ${colors.border}` }}
                      disabled={isBusy}
                      onClick={() => setExpanded(prev => ({ ...prev, [m.id]: !prev[m.id] }))}
                    >
                      {expanded[m.id] ? 'Hide details' : 'Details'}
                    </button>
                    {canManage && (
                      <button style={s.btnSm} disabled={isBusy} onClick={() => discover(m.id)}>
                        {isBusy ? 'Discovering…' : 'Discover prospects'}
                      </button>
                    )}
                    {canManage && (m.status === 'PAUSED' || m.status === 'DRAFT' ? (
                      <button style={s.btnSm} disabled={isBusy} onClick={() => setStatus(m.id, 'ACTIVE')}>Activate</button>
                    ) : m.status !== 'COMPLETE' ? (
                      <button style={s.btnSm} disabled={isBusy} onClick={() => setStatus(m.id, 'PAUSED')}>Pause</button>
                    ) : null)}
                    {canManage && m.status !== 'COMPLETE' && (
                      <button style={{ ...s.btnSm, border: `1px solid ${colors.border}` }} disabled={isBusy} onClick={() => setStatus(m.id, 'COMPLETE')}>
                        Complete
                      </button>
                    )}
                  </div>
                </div>
                {expanded[m.id] && <MissionDetailPanel api={api} missionId={m.id} toast={toast} />}
              </div>
            )
          })}
        </div>
      )}

      {showBuilder && workspace && (
        <MissionBuilder
          workspace={workspace}
          api={api}
          toast={toast}
          onCreated={() => { setShowBuilder(false); toast.success('Mission launched'); load() }}
          onClose={() => setShowBuilder(false)}
        />
      )}
    </div>
  )
}

// The mission control plane: playbook, discovery history, owned prospects, and
// the actionable outreach queue scoped to this mission. Lazy-loaded on expand.
function MissionDetailPanel({ api, missionId, toast }: { api: ApiHook; missionId: string; toast: ToastHook }) {
  const [detail, setDetail] = useState<MissionDetail | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api<MissionDetail>(`/api/missions/${missionId}`)
      .then(d => { if (!cancelled) setDetail(d) })
      .catch(e => { if (!cancelled) toast.error(e instanceof Error ? e.message : 'Failed to load mission detail') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [api, missionId])

  const panel: React.CSSProperties = { borderTop: `1px solid ${colors.border}`, marginTop: 8, paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }
  const heading: React.CSSProperties = { color: colors.textFaint, fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }

  if (loading) return <div style={panel}><span style={{ color: colors.textMuted, fontSize: 12 }}>Loading details…</span></div>
  if (!detail) return null

  return (
    <div style={panel}>
      <div>
        <div style={heading}>Playbook</div>
        <div style={{ color: colors.textMuted, fontSize: 13, marginTop: 4 }}>
          {detail.playbook ? detail.playbook.label : 'No playbook — uses workspace ICP'}
        </div>
      </div>

      <div>
        <div style={heading}>Action queue</div>
        {detail.intents.length === 0 ? (
          <div style={{ color: colors.textFaint, fontSize: 12, marginTop: 4 }}>No pending outreach yet — discover and score prospects to populate it.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
            {detail.intents.map(i => (
              <div key={i.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13 }}>
                <span style={{ color: colors.text }}>{i.prospect?.companyName ?? 'Unknown'}</span>
                <span style={{ color: colors.textMuted }}>
                  {i.status}{i.prospect ? ` · score ${i.prospect.opportunityScore}` : ''}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <div style={heading}>Top prospects</div>
        {detail.prospects.length === 0 ? (
          <div style={{ color: colors.textFaint, fontSize: 12, marginTop: 4 }}>None discovered for this mission yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
            {detail.prospects.map(p => (
              <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13 }}>
                <span style={{ color: colors.text }}>{p.companyName}{p.industry ? ` · ${p.industry}` : ''}</span>
                <span style={{ color: colors.textMuted }}>score {p.opportunityScore}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <div style={heading}>Discovery history</div>
        {detail.discoveryRuns.length === 0 ? (
          <div style={{ color: colors.textFaint, fontSize: 12, marginTop: 4 }}>No discovery runs yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
            {detail.discoveryRuns.map(r => (
              <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12 }}>
                <span style={{ color: colors.textMuted }}>{r.source}</span>
                <span style={{ color: r.status === 'FAILED' ? colors.red : colors.textMuted }}>
                  {r.status === 'FAILED'
                    ? `failed${r.errorMessage ? ` — ${r.errorMessage}` : ''}`
                    : `${r.importedCount} imported · ${r.skippedCount} skipped`}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
