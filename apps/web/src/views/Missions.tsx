import React, { useEffect, useState, useCallback } from 'react'
import type { UpdateMissionRequest } from '@acaos/shared'
import type { Mission, MissionStatus, Workspace } from '../types.js'
import { s, colors } from '../styles.js'
import { Spinner, EmptyState } from '../components/Spinner.js'
import { MissionBuilder } from '../components/MissionBuilder.js'
import type { ApiHook } from '../hooks/useApi.js'
import type { ToastHook } from '../hooks/useToast.js'

type Props = { api: ApiHook; workspace: Workspace | null; toast: ToastHook }

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

export function MissionsView({ api, workspace, toast }: Props) {
  const [missions, setMissions] = useState<Mission[]>([])
  const [loading, setLoading] = useState(true)
  const [showBuilder, setShowBuilder] = useState(false)
  const [busy, setBusy] = useState<Record<string, boolean>>({})

  const load = useCallback(() => {
    if (!workspace) return
    setLoading(true)
    api<{ missions: Mission[] }>(`/api/missions?workspaceId=${workspace.id}`)
      .then(d => setMissions(d.missions || []))
      .catch(e => toast.error(e instanceof Error ? e.message : 'Failed to load missions'))
      .finally(() => setLoading(false))
  }, [api, workspace?.id, toast])

  useEffect(() => { load() }, [workspace?.id])

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

  if (!workspace) return null
  if (loading) return <Spinner />

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <p style={{ color: colors.textMuted, fontSize: 13, margin: 0 }}>
          A mission ties your target, offer, and outreach into one tracked workflow.
        </p>
        <button style={s.btn} onClick={() => setShowBuilder(true)}>+ New Mission</button>
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
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
                  <span style={{ color: colors.textFaint, fontSize: 12 }}>{leads} lead{leads !== 1 ? 's' : ''} enrolled</span>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {m.status === 'PAUSED' || m.status === 'DRAFT' ? (
                      <button style={s.btnSm} disabled={isBusy} onClick={() => setStatus(m.id, 'ACTIVE')}>Activate</button>
                    ) : m.status !== 'COMPLETE' ? (
                      <button style={s.btnSm} disabled={isBusy} onClick={() => setStatus(m.id, 'PAUSED')}>Pause</button>
                    ) : null}
                    {m.status !== 'COMPLETE' && (
                      <button style={{ ...s.btnSm, border: `1px solid ${colors.border}` }} disabled={isBusy} onClick={() => setStatus(m.id, 'COMPLETE')}>
                        Complete
                      </button>
                    )}
                  </div>
                </div>
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
