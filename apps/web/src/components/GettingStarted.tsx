import React, { useEffect, useState, useCallback, useMemo } from 'react'
import { s, colors } from '../styles.js'
import { makeRouteApi } from '../lib/routeApi.js'
import type { ApiHook } from '../hooks/useApi.js'
import type { ToastHook } from '../hooks/useToast.js'
import type { View } from '../types.js'

type ReadinessCheck = { name: string; label: string; ok: boolean; hint: string }
type Readiness = { ready: boolean; checks: ReadinessCheck[] }

type Props = {
  api: ApiHook
  workspaceId: string
  toast: ToastHook
  setView?: (v: View) => void
}

// Onboarding card: shows exactly what's left before this workspace can send
// outreach, plus a one-click "apply the FieldOps preset" shortcut. Collapses
// itself once the workspace is send-ready so it doesn't clutter the dashboard.
export function GettingStarted({ api, workspaceId, toast, setView }: Props) {
  const route = useMemo(() => makeRouteApi(api), [api])
  const [readiness, setReadiness] = useState<Readiness | null>(null)
  const [applying, setApplying] = useState(false)

  const load = useCallback(() => {
    api<Readiness>(`/api/campaigns/send-readiness?workspaceId=${workspaceId}`)
      .then(setReadiness)
      .catch(() => {})
  }, [api, workspaceId])

  useEffect(() => { load() }, [load])

  async function applyFieldOps() {
    setApplying(true)
    try {
      await route('POST /api/packs/fieldops/apply', { body: { workspaceId } })
      toast.success('FieldOps preset applied — your targeting is set for trades & field service')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not apply pack')
    } finally {
      setApplying(false)
    }
  }

  // Render nothing until we have a well-formed not-ready response. A ready
  // workspace (or a malformed/empty payload) stays out of the way.
  const checks = Array.isArray(readiness?.checks) ? readiness!.checks : []
  if (!readiness || readiness.ready || checks.length === 0) return null

  const done = checks.filter(c => c.ok).length
  const total = checks.length

  return (
    <div style={{ ...s.card, borderColor: colors.blue + '55' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <div style={s.sectionHeader}>Get set up to send</div>
        <span style={{ color: colors.textFaint, fontSize: 12 }}>{done}/{total} ready</span>
      </div>
      <div style={{ color: colors.textMuted, fontSize: 13, marginBottom: 12 }}>
        A couple of steps before ACAOS can send outreach on your behalf.
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {checks.map(c => (
          <div key={c.name} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <span style={{ color: c.ok ? colors.green : colors.amber, fontWeight: 700, fontSize: 14, lineHeight: '20px' }}>
              {c.ok ? '✓' : '○'}
            </span>
            <div>
              <div style={{ color: colors.text, fontSize: 13, fontWeight: 600 }}>{c.label}</div>
              {!c.ok && <div style={{ color: colors.textFaint, fontSize: 12 }}>{c.hint}</div>}
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        {setView && (
          <button style={{ ...s.btn, background: colors.blue }} onClick={() => setView('settings')}>
            Configure sender →
          </button>
        )}
        <button style={s.btnGhost} onClick={applyFieldOps} disabled={applying}>
          {applying ? 'Applying…' : 'Apply FieldOps preset'}
        </button>
      </div>
    </div>
  )
}
