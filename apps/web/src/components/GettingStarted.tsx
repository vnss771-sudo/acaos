import React, { useEffect, useState, useCallback, useMemo } from 'react'
import { s, colors } from '../styles.js'
import { makeRouteApi } from '../lib/routeApi.js'
import type { ApiHook } from '../hooks/useApi.js'
import type { ToastHook } from '../hooks/useToast.js'
import type { View } from '../types.js'
import { openSettingsSection, type SettingsSection } from '../lib/settingsSections.js'

type ReadinessCheck = { name: string; label: string; ok: boolean; hint: string }

// Where in Settings each readiness check is fixed, so every unfinished item gets
// a button that lands on the exact form — not the top of a 12-section page.
const CHECK_SECTIONS: Record<string, SettingsSection> = {
  smtpConfigured: 'email',
  senderBusinessName: 'workspace',
  senderPostalAddress: 'workspace',
  lawfulBasis: 'compliance',
  termsAccepted: 'compliance',
  caslConsent: 'compliance',
}
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
        You can explore everything now. Before ACAOS can send emails for you, finish these steps —
        each one takes a minute or two.
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {checks.map(c => {
          const section = CHECK_SECTIONS[c.name]
          return (
            <div key={c.name} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <span style={{ color: c.ok ? colors.green : colors.amber, fontWeight: 700, fontSize: 14, lineHeight: '20px' }}>
                {c.ok ? '✓' : '○'}
              </span>
              <div style={{ flex: 1 }}>
                <div style={{ color: colors.text, fontSize: 13, fontWeight: 600 }}>{c.label}</div>
                {!c.ok && <div style={{ color: colors.textFaint, fontSize: 12 }}>{c.hint}</div>}
              </div>
              {!c.ok && setView && section && (
                <button
                  style={{ ...s.btnGhost, fontSize: 12, padding: '4px 10px', whiteSpace: 'nowrap' }}
                  onClick={() => openSettingsSection(setView, section)}
                  aria-label={`Set up: ${c.label}`}
                >
                  Set up →
                </button>
              )}
            </div>
          )
        })}
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 14, color: colors.textFaint, fontSize: 12 }}>
        <span>Selling to trades or field-service businesses?</span>
        <button style={{ ...s.btnGhost, fontSize: 12, padding: '4px 10px' }} onClick={applyFieldOps} disabled={applying}>
          {applying ? 'Applying…' : 'Apply FieldOps preset'}
        </button>
      </div>
    </div>
  )
}
