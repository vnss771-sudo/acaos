import React, { useEffect, useState } from 'react'
import { useEscapeKey } from '../hooks/useEscapeKey.js'
import { s, colors } from '../styles.js'
import type { ApiHook } from '../hooks/useApi.js'
import type { Workspace } from '../types.js'

type DomainCheck = { hasSPF: boolean; hasDKIM: boolean }

type Props = {
  api: ApiHook
  workspace: Workspace
  pending: { id: string; name: string; eligible: number }
  onCancel: () => void
  onConfirm: () => void
}

// The launch-approval modal owns its own deliverability (SPF/DKIM) check so that
// self-contained concern — and its loading state — lives here rather than
// inflating the Campaigns view. The parent only decides when to show it.
export function LaunchApprovalModal({ api, workspace, pending, onCancel, onConfirm }: Props) {
  const [domainCheck, setDomainCheck] = useState<DomainCheck | null | 'loading'>('loading')

  useEscapeKey(onCancel)

  useEffect(() => {
    let cancelled = false
    setDomainCheck('loading')
    api<{ config: { smtpFrom?: string | null } | null }>(`/api/workspaces/${workspace.id}/email-config`)
      .then(({ config }) => {
        const smtpFrom = config?.smtpFrom || ''
        const atIdx = smtpFrom.lastIndexOf('@')
        // Extract domain from "Name <user@domain.com>" or "user@domain.com"
        const raw = atIdx !== -1 ? smtpFrom.slice(atIdx + 1).replace(/[>\s]+$/, '').trim() : ''
        if (!raw) {
          if (!cancelled) setDomainCheck({ hasSPF: false, hasDKIM: false })
          return
        }
        return api<DomainCheck>(
          `/api/mailbox/check-domain?domain=${encodeURIComponent(raw)}&workspaceId=${encodeURIComponent(workspace.id)}`
        ).then(result => {
          if (!cancelled) setDomainCheck({ hasSPF: result.hasSPF, hasDKIM: result.hasDKIM })
        })
      })
      .catch(() => {
        if (!cancelled) setDomainCheck({ hasSPF: false, hasDKIM: false })
      })
    return () => { cancelled = true }
  }, [pending.id, workspace.id, api])

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center'
      }}
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Confirm campaign launch"
        style={{
          background: colors.bgCard, border: `1px solid ${colors.border}`,
          borderRadius: 12, padding: 28, width: 420, maxWidth: '90vw'
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ fontSize: 18, fontWeight: 700, color: colors.text, marginBottom: 8 }}>
          Approve Outreach Mission
        </div>
        <div style={{ color: colors.textMuted, fontSize: 13, marginBottom: 20 }}>
          Campaign: <strong style={{ color: colors.text }}>{pending.name}</strong>
        </div>
        <div style={{
          background: `${colors.amber}18`, border: `1px solid ${colors.amber}44`,
          borderRadius: 8, padding: '12px 16px', marginBottom: 20
        }}>
          <div style={{ color: colors.amber, fontWeight: 700, fontSize: 20 }}>{pending.eligible}</div>
          <div style={{ color: colors.textFaint, fontSize: 13 }}>
            leads will each receive a personalised AI-generated email.
          </div>
        </div>
        <div style={{
          background: colors.bgElevated, border: `1px solid ${colors.border}`,
          borderRadius: 8, padding: '12px 16px', marginBottom: 20, fontSize: 12
        }}>
          <div style={{ color: colors.textMuted, fontWeight: 700, marginBottom: 8, fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Deliverability checklist</div>
          {/* SPF — dynamic */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 4 }}>
            <span style={{ color: domainCheck === 'loading' ? colors.textFaint : domainCheck?.hasSPF ? colors.green : colors.red, flexShrink: 0 }}>
              {domainCheck === 'loading' ? '…' : domainCheck?.hasSPF ? '✓' : '✗'}
            </span>
            <span style={{ color: colors.textFaint }}>
              {domainCheck === 'loading'
                ? 'Checking… SPF record (v=spf1 include:…)'
                : domainCheck?.hasSPF
                  ? 'Sending domain has SPF record (v=spf1 include:…)'
                  : 'Sending domain has SPF record (v=spf1 include:…) — not detected'}
            </span>
          </div>
          {/* DKIM — dynamic */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 4 }}>
            <span style={{ color: domainCheck === 'loading' ? colors.textFaint : domainCheck?.hasDKIM ? colors.green : colors.red, flexShrink: 0 }}>
              {domainCheck === 'loading' ? '…' : domainCheck?.hasDKIM ? '✓' : '✗'}
            </span>
            <span style={{ color: colors.textFaint }}>
              {domainCheck === 'loading'
                ? 'Checking… DKIM signature configured for sending domain'
                : domainCheck?.hasDKIM
                  ? 'DKIM signature configured for sending domain'
                  : 'DKIM signature configured for sending domain — not detected'}
            </span>
          </div>
          {/* Static items */}
          {[
            'Sending address matches your workspace email config',
            'Lead list has been reviewed for quality',
          ].map(item => (
            <div key={item} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 4 }}>
              <span style={{ color: colors.green, flexShrink: 0 }}>✓</span>
              <span style={{ color: colors.textFaint }}>{item}</span>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button style={s.btnSecondary} onClick={onCancel}>Cancel</button>
          <button style={{ ...s.btn, background: colors.greenDark }} onClick={onConfirm}>
            Approve &amp; Send
          </button>
        </div>
      </div>
    </div>
  )
}
