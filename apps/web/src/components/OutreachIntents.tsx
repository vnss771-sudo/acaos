import React, { useEffect, useState, useCallback, useMemo } from 'react'
import { s, colors } from '../styles.js'
import { makeRouteApi } from '../lib/routeApi.js'
import type { ApiHook } from '../hooks/useApi.js'
import type { ToastHook } from '../hooks/useToast.js'
import { SendFirstEmailModal, type SendableIntent } from './SendFirstEmailModal.js'

type IntentRow = {
  id: string
  status: string
  origin?: string
  leadId?: string | null
  campaignId?: string | null
  campaignName?: string | null
  recipientSuppressed?: boolean
  messageAngle: string | null
  draftSubject: string | null
  draftBody: string | null
  prospect: { id: string; companyName: string; industry: string | null; location: string | null; opportunityScore: number | null; contactEmail?: string | null; contactName?: string | null } | null
  recommendation: { reasoning: string | null; actionText: string | null; urgency: string | null } | null
}

type Props = { api: ApiHook; workspaceId: string; toast: ToastHook; senderBusinessName?: string | null }

// "This week's outreach" — turns the OutreachIntent bridge into an operable
// surface: each evidence-backed opportunity can be drafted → approved → prepared
// to send inline, no API/curl needed. Hides itself when there's nothing to act on.
export function OutreachIntents({ api, workspaceId, toast, senderBusinessName }: Props) {
  const route = useMemo(() => makeRouteApi(api), [api])
  const [intents, setIntents] = useState<IntentRow[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [sendTarget, setSendTarget] = useState<SendableIntent | null>(null)
  // Dispatched this session — the worker flips the intent to SENT asynchronously,
  // so hide the send button meanwhile rather than invite a second click.
  const [dispatched, setDispatched] = useState<Set<string>>(() => new Set())

  const load = useCallback((): Promise<IntentRow[]> => {
    return api<{ intents: IntentRow[] }>(`/api/prospects/intents?workspaceId=${workspaceId}`)
      .then((d) => { const rows = d.intents || []; setIntents(rows); return rows })
      .catch(() => { setIntents([]); return [] })
  }, [api, workspaceId])

  function openSend(it: IntentRow) {
    if (!it.leadId || !it.campaignId) return
    setSendTarget({
      id: it.id, leadId: it.leadId, campaignId: it.campaignId, campaignName: it.campaignName ?? null,
      recipientSuppressed: !!it.recipientSuppressed, draftSubject: it.draftSubject, draftBody: it.draftBody,
      prospect: it.prospect ? { companyName: it.prospect.companyName, contactEmail: it.prospect.contactEmail ?? null, contactName: it.prospect.contactName ?? null } : null,
    })
  }
  useEffect(() => { load() }, [load])

  async function act(intent: IntentRow, action: 'draft' | 'approve' | 'materialize') {
    if (!intent.prospect) return
    setBusyId(intent.id)
    try {
      await route('POST /api/prospects/:prospectId/intents/:intentId/:action', {
        params: { prospectId: intent.prospect.id, intentId: intent.id, action }
      })
      if (action !== 'materialize') toast.success(action === 'draft' ? 'Draft generated' : 'Approved')
      const rows = await load()
      // Straight to the send gate — no detour through Campaigns.
      if (action === 'materialize') {
        const prepared = rows.find((r) => r.id === intent.id)
        if (prepared) openSend(prepared)
      }
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
              {it.origin === 'ONBOARDING' && (
                <div style={{ color: colors.amber, fontSize: 12, marginTop: 4 }}>
                  Prepared so you can see how ACAOS works on your own data — not an evidence-based recommendation.
                </div>
              )}
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
                {it.status === 'APPROVED' && !it.leadId && (
                  <button style={{ ...s.btn }} disabled={busy} onClick={() => act(it, 'materialize')}>{busy ? '…' : 'Prepare to send →'}</button>
                )}
                {it.status === 'APPROVED' && it.leadId && it.campaignId && dispatched.has(it.id) && (
                  <span style={{ color: colors.green, fontSize: 13 }}>Sending…</span>
                )}
                {it.status === 'APPROVED' && it.leadId && it.campaignId && !dispatched.has(it.id) && (
                  <button style={{ ...s.btn, background: colors.greenDark }} disabled={busy} onClick={() => openSend(it)}>Send email…</button>
                )}
              </div>
            </div>
          )
        })}
      </div>
      {sendTarget && (
        <SendFirstEmailModal
          api={api} workspaceId={workspaceId} senderBusinessName={senderBusinessName} intent={sendTarget} toast={toast}
          onCancel={() => setSendTarget(null)}
          onSent={() => { const id = sendTarget.id; setDispatched((d) => new Set(d).add(id)); setSendTarget(null); load() }}
        />
      )}
    </div>
  )
}
