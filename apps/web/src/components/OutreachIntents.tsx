import React, { useEffect, useState, useCallback } from 'react'
import { s, colors } from '../styles.js'
import type { ApiHook } from '../hooks/useApi.js'
import type { ToastHook } from '../hooks/useToast.js'

type IntentRow = {
  id: string
  status: string
  messageAngle: string | null
  draftSubject: string | null
  draftBody: string | null
  prospect: { id: string; companyName: string; industry: string | null; location: string | null; opportunityScore: number | null } | null
  recommendation: { reasoning: string | null; actionText: string | null; urgency: string | null } | null
}

type Props = { api: ApiHook; workspaceId: string; toast: ToastHook }

// "This week's outreach" — turns the OutreachIntent bridge into an operable
// surface: each evidence-backed opportunity can be drafted → approved → prepared
// to send inline, no API/curl needed. Hides itself when there's nothing to act on.
export function OutreachIntents({ api, workspaceId, toast }: Props) {
  const [intents, setIntents] = useState<IntentRow[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(() => {
    api<{ intents: IntentRow[] }>(`/api/prospects/intents?workspaceId=${workspaceId}`)
      .then((d) => setIntents(d.intents || []))
      .catch(() => setIntents([]))
  }, [api, workspaceId])
  useEffect(() => { load() }, [load])

  async function act(intent: IntentRow, action: 'draft' | 'approve' | 'materialize') {
    if (!intent.prospect) return
    setBusyId(intent.id)
    try {
      await api(`/api/prospects/${intent.prospect.id}/intents/${intent.id}/${action}`, { method: 'POST', body: JSON.stringify({}) })
      toast.success(
        action === 'draft' ? 'Draft generated' :
        action === 'approve' ? 'Approved' :
        'Prepared to send — launch the campaign to dispatch',
      )
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Action failed')
    } finally {
      setBusyId(null)
    }
  }

  if (!intents || intents.length === 0) return null
  const border = `1px solid ${colors.border ?? '#1e2d40'}`

  return (
    <div style={s.card}>
      <div style={s.sectionHeader}>This week’s outreach — {intents.length} {intents.length === 1 ? 'opportunity' : 'opportunities'}</div>
      <div style={{ color: colors.textMuted, fontSize: 13, margin: '4px 0 12px' }}>
        Evidence-backed companies worth contacting. Review, approve, then send — you stay in control of every message.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {intents.map((it) => {
          const p = it.prospect
          const busy = busyId === it.id
          return (
            <div key={it.id} style={{ border, borderRadius: 8, padding: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                <div style={{ color: colors.text, fontWeight: 700 }}>{p?.companyName ?? 'Unknown company'}</div>
                <span style={{ color: colors.textFaint, fontSize: 12 }}>
                  score {p?.opportunityScore ?? '—'} · <span style={{ color: colors.blue }}>{it.status}</span>
                </span>
              </div>
              {(it.recommendation?.reasoning || it.messageAngle) && (
                <div style={{ color: colors.textMuted, fontSize: 13, marginTop: 4 }}>
                  {it.recommendation?.reasoning || it.messageAngle}
                </div>
              )}
              {it.draftSubject && (
                <div style={{ marginTop: 8, fontSize: 13, background: '#0b1220', borderRadius: 6, padding: 10 }}>
                  <div style={{ color: colors.text, fontWeight: 600 }}>{it.draftSubject}</div>
                  <div style={{ color: colors.textFaint, whiteSpace: 'pre-wrap', marginTop: 4 }}>{it.draftBody}</div>
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                {it.status === 'PROPOSED' && (
                  <button style={s.btnSm} disabled={busy} onClick={() => act(it, 'draft')}>{busy ? '…' : 'Generate draft'}</button>
                )}
                {it.status === 'DRAFTED' && (
                  <button style={{ ...s.btnSm, background: colors.green }} disabled={busy} onClick={() => act(it, 'approve')}>{busy ? '…' : 'Approve'}</button>
                )}
                {it.status === 'APPROVED' && (
                  <button style={{ ...s.btn }} disabled={busy} onClick={() => act(it, 'materialize')}>{busy ? '…' : 'Prepare to send →'}</button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
