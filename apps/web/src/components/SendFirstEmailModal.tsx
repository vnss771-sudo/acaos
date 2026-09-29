import React, { useEffect, useMemo, useState } from 'react'
import type { SendCampaignRequest } from '@acaos/shared'
import { useEscapeKey } from '../hooks/useEscapeKey.js'
import { makeRouteApi } from '../lib/routeApi.js'
import { s, colors } from '../styles.js'
import type { ApiHook } from '../hooks/useApi.js'
import type { ToastHook } from '../hooks/useToast.js'

type ReadinessCheck = { name: string; label: string; ok: boolean; hint: string }

export type SendableIntent = {
  id: string
  leadId: string
  campaignId: string
  campaignName: string | null
  recipientSuppressed: boolean
  draftSubject: string | null
  draftBody: string | null
  prospect: { companyName: string; contactEmail: string | null; contactName: string | null } | null
}

type Props = {
  api: ApiHook
  workspaceId: string
  senderBusinessName?: string | null
  intent: SendableIntent
  toast: ToastHook
  onCancel: () => void
  onSent: () => void
}

// The send gate — separate from the approval gate. The draft is already approved;
// this shows exactly what will go out, from whom, to whom, and whether the
// workspace is allowed to send, then dispatches just this one lead via the normal
// campaign send endpoint (which re-enforces readiness, approval mode and caps).
export function SendFirstEmailModal({ api, workspaceId, senderBusinessName, intent, toast, onCancel, onSent }: Props) {
  const route = useMemo(() => makeRouteApi(api), [api])
  const [checks, setChecks] = useState<ReadinessCheck[] | null>(null)
  const [smtpFrom, setSmtpFrom] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  useEscapeKey(onCancel)

  useEffect(() => {
    let cancelled = false
    api<{ ready: boolean; checks: ReadinessCheck[] }>(`/api/campaigns/send-readiness?workspaceId=${workspaceId}`)
      .then((r) => { if (!cancelled) setChecks(r.checks ?? []) })
      .catch(() => { if (!cancelled) setChecks([]) })
    api<{ config: { smtpFrom?: string | null } | null }>(`/api/workspaces/${workspaceId}/email-config`)
      .then(({ config }) => { if (!cancelled) setSmtpFrom(config?.smtpFrom ?? null) })
      .catch(() => { if (!cancelled) setSmtpFrom(null) })
    return () => { cancelled = true }
  }, [api, workspaceId])

  const blocking = (checks ?? []).filter((c) => !c.ok)
  const canSend = checks !== null && blocking.length === 0 && !intent.recipientSuppressed && !!intent.prospect?.contactEmail

  async function send() {
    setSending(true)
    try {
      const body: SendCampaignRequest = { approved: true, leadIds: [intent.leadId] }
      await route('POST /api/campaigns/:id/send', { params: { id: intent.campaignId }, body })
      toast.success(`Sending to ${intent.prospect?.contactEmail ?? 'recipient'}`)
      onSent()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Send failed')
    } finally {
      setSending(false)
    }
  }

  const row = (label: string, value: React.ReactNode) => (
    <div style={{ display: 'flex', gap: 8, fontSize: 13, marginBottom: 4 }}>
      <span style={{ color: colors.textFaint, minWidth: 80 }}>{label}</span>
      <span style={{ color: colors.text, wordBreak: 'break-word' }}>{value}</span>
    </div>
  )

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Send this email now?"
        style={{ background: colors.bgCard, border: `1px solid ${colors.border}`, borderRadius: 12, padding: 24, width: 520, maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontSize: 18, fontWeight: 700, color: colors.text, marginBottom: 12 }}>Send this email now?</div>

        {row('To', `${intent.prospect?.contactName ? `${intent.prospect.contactName} ` : ''}<${intent.prospect?.contactEmail ?? 'no email'}>`)}
        {row('Company', intent.prospect?.companyName ?? '—')}
        {row('From', `${senderBusinessName || 'Business name not set'}${smtpFrom ? ` <${smtpFrom}>` : ''}`)}
        {row('Campaign', intent.campaignName ?? '—')}

        <div style={{ marginTop: 12, background: colors.bgElevated, border: `1px solid ${colors.border}`, borderRadius: 8, padding: 12 }}>
          <div style={{ color: colors.text, fontWeight: 600, fontSize: 14 }}>{intent.draftSubject}</div>
          <div style={{ color: colors.textMuted, fontSize: 13, whiteSpace: 'pre-wrap', marginTop: 6 }}>{intent.draftBody}</div>
        </div>

        <div style={{ marginTop: 12, fontSize: 12 }}>
          <div style={{ color: colors.textMuted, fontWeight: 700, marginBottom: 6, fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Ready to send</div>
          {checks === null && <div style={{ color: colors.textFaint }}>Checking…</div>}
          {(checks ?? []).map((c) => (
            <div key={c.name} style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
              <span style={{ color: c.ok ? colors.green : colors.red }}>{c.ok ? '✓' : '✗'}</span>
              <span style={{ color: colors.textFaint }}>{c.label}{c.ok ? '' : ` — ${c.hint}`}</span>
            </div>
          ))}
          {intent.recipientSuppressed && (
            <div role="alert" style={{ color: colors.red, marginTop: 6 }}>
              This address is on your suppression list (unsubscribed, bounced or complained) and won’t be emailed.
            </div>
          )}
          {blocking.length > 0 && (
            <div style={{ color: colors.amber, marginTop: 6 }}>Finish the items above in Settings, then come back to send.</div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 16 }}>
          <button style={s.btnSecondary} onClick={onCancel}>Not now</button>
          <button style={{ ...s.btn, background: colors.greenDark }} disabled={!canSend || sending} onClick={send}>
            {sending ? 'Sending…' : 'Send email'}
          </button>
        </div>
      </div>
    </div>
  )
}
