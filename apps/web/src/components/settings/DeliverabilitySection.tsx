import React from 'react'
import { s, colors } from '../../styles.js'
import { Spinner } from '../Spinner.js'

export type DomainCheckResult = { hasSPF: boolean; hasDKIM: boolean } | null

export function DeliverabilitySection({
  smtpFromConfigured, domainCheck, domainCheckLoading, suppressionCount,
  dailySendLimit, approvalMode,
}: {
  smtpFromConfigured: boolean
  domainCheck: DomainCheckResult
  domainCheckLoading: boolean
  suppressionCount: number | null
  dailySendLimit?: number
  approvalMode?: boolean
}) {
  return (
    <div style={s.card}>
      <div style={s.sectionHeader}>Compliance &amp; Deliverability</div>
      <div style={{ color: colors.textMuted, fontSize: 13, marginBottom: 16 }}>
        Real-time health check for your sending domain and outreach compliance.
      </div>
      {!smtpFromConfigured ? (
        <div style={{
          background: '#0f172a', border: `1px solid ${colors.border}`,
          borderRadius: 8, padding: '12px 16px', color: colors.textMuted, fontSize: 13
        }}>
          Configure your email settings above to enable deliverability checks.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          {/* Sending domain */}
          <div style={{ ...s.cardInner }}>
            <div style={{ color: colors.textFaint, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10 }}>
              Sending Domain
            </div>
            {domainCheckLoading ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: colors.textMuted, fontSize: 13 }}>
                <Spinner size={13} /> Checking DNS records…
              </div>
            ) : domainCheck ? (
              <div style={{ display: 'grid', gap: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ color: colors.textMuted, fontSize: 13 }}>SPF record</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: domainCheck.hasSPF ? colors.green : colors.red }}>
                    {domainCheck.hasSPF ? '✓ Configured' : '✗ Missing'}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ color: colors.textMuted, fontSize: 13 }}>DKIM signature</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: domainCheck.hasDKIM ? colors.green : colors.red }}>
                    {domainCheck.hasDKIM ? '✓ Configured' : '✗ Missing'}
                  </span>
                </div>
              </div>
            ) : (
              <div style={{ color: colors.textFaint, fontSize: 13 }}>DNS lookup unavailable</div>
            )}
          </div>

          {/* Unsubscribe coverage */}
          <div style={{ ...s.cardInner, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ color: colors.textMuted, fontSize: 13 }}>Unsubscribe coverage</span>
            <span style={{ fontSize: 13, fontWeight: 600, color: colors.green }}>
              ✓ All outbound emails include unsubscribe link
            </span>
          </div>

          {/* Suppression list */}
          <div style={{ ...s.cardInner, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ color: colors.textMuted, fontSize: 13 }}>Suppression list</span>
            <span style={{ fontSize: 13, fontWeight: 600, color: colors.text }}>
              {suppressionCount !== null
                ? `${suppressionCount} contact${suppressionCount !== 1 ? 's' : ''} suppressed`
                : 'Active'}
            </span>
          </div>

          {/* Email footer */}
          <div style={{ ...s.cardInner, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ color: colors.textMuted, fontSize: 13 }}>Email footer</span>
            <span style={{ fontSize: 13, fontWeight: 600, color: colors.green }}>
              ✓ Unsubscribe link included
            </span>
          </div>

          {/* Sending limits */}
          <div style={{ ...s.cardInner }}>
            <div style={{ color: colors.textFaint, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10 }}>
              Sending Limits
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ color: colors.textMuted, fontSize: 13 }}>Daily limit</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: colors.text }}>
                  {dailySendLimit != null ? `${dailySendLimit} emails` : '50 emails (default)'}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ color: colors.textMuted, fontSize: 13 }}>Approval mode</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: approvalMode !== false ? colors.amber : colors.green }}>
                  {approvalMode !== false ? 'ON — campaigns require approval' : 'OFF — campaigns send automatically'}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
