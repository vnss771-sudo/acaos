import React from 'react'
import { s, colors } from '../../styles.js'
import { Spinner } from '../Spinner.js'

export type DomainIssue = { code: string; severity: 'critical' | 'warning' | 'info'; message: string }

export type DomainCheckResult = {
  hasSPF: boolean
  hasDKIM: boolean
  // Present when the API returns the full report (DMARC + blocklists).
  dmarc?: { status: 'ok' | 'missing' | 'error'; policy: string | null }
  blocklists?: Array<{ zone: string; status: 'listed' | 'clean' | 'error' }>
  issues?: DomainIssue[]
} | null

/** When the scheduled daily check last ran for the workspace's sending domain. */
export type DomainMonitor = { checkedAt: string | null; status: 'healthy' | 'warning' | 'critical' | 'unknown' | null }

function Row({ label, ok, okText, badText, neutral }: { label: string; ok: boolean; okText: string; badText: string; neutral?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <span style={{ color: colors.textMuted, fontSize: 13 }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 600, color: neutral ? colors.textFaint : ok ? colors.green : colors.red }}>
        {ok ? `✓ ${okText}` : neutral ? badText : `✗ ${badText}`}
      </span>
    </div>
  )
}

function dmarcText(d: NonNullable<NonNullable<DomainCheckResult>['dmarc']>): { ok: boolean; neutral: boolean; text: string } {
  if (d.status === 'error') return { ok: false, neutral: true, text: 'Lookup failed' }
  if (d.status === 'missing') return { ok: false, neutral: false, text: 'Missing' }
  return { ok: true, neutral: false, text: `Configured (p=${d.policy ?? '?'})` }
}

function blocklistRow(lists: NonNullable<NonNullable<DomainCheckResult>['blocklists']>): { ok: boolean; neutral: boolean; text: string } {
  const listed = lists.filter((l) => l.status === 'listed').map((l) => l.zone)
  if (listed.length) return { ok: false, neutral: false, text: `Listed on ${listed.join(', ')}` }
  const failed = lists.filter((l) => l.status === 'error').length
  if (failed === lists.length) return { ok: false, neutral: true, text: 'Lookup failed' }
  return { ok: true, neutral: false, text: failed ? `Not listed (${failed} of ${lists.length} unavailable)` : 'Not listed' }
}

export type WarmupStatus = {
  active: boolean
  startedAt: string | null
  day: number | null
  totalDays: number
  cap: number | null
  complete: boolean
}

export type ReputationVerdict = {
  healthy: boolean
  totalSends: number
  bounces: number
  complaints: number
  bounceRate: number
  complaintRate: number
  reason: 'BOUNCE_RATE_HIGH' | 'COMPLAINT_RATE_HIGH' | null
  thresholds: { windowDays: number; minSends: number; maxBounceRate: number; maxComplaintRate: number }
  guardMode: 'observe' | 'enforce' | string
}

function pct(n: number): string {
  return `${(n * 100).toFixed(2)}%`
}

/** "Not started" | "Warming up — day X of N, today's cap: Y/day" | "Warmup complete". */
function warmupHeadline(w: WarmupStatus): string {
  if (!w.active) return 'Not started'
  if (w.complete) return 'Warmup complete — full daily limit applies'
  return `Warming up — day ${w.day} of ${w.totalDays}, today's cap: ${w.cap}/day`
}

export function DeliverabilitySection({
  smtpFromConfigured, domainCheck, domainCheckLoading, suppressionCount,
  dailySendLimit, approvalMode, warmup, reputation, canManage, startingWarmup, onStartWarmup, monitor,
}: {
  smtpFromConfigured: boolean
  domainCheck: DomainCheckResult
  domainCheckLoading: boolean
  suppressionCount: number | null
  dailySendLimit?: number
  approvalMode?: boolean
  warmup?: WarmupStatus | null
  reputation?: ReputationVerdict | null
  canManage?: boolean
  startingWarmup?: boolean
  onStartWarmup?: () => void
  monitor?: DomainMonitor | null
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
                <Row label="SPF record" ok={domainCheck.hasSPF} okText="Configured" badText="Missing" />
                <Row label="DKIM signature" ok={domainCheck.hasDKIM} okText="Configured" badText="Missing" />
                {domainCheck.dmarc && (() => {
                  const d = dmarcText(domainCheck.dmarc)
                  return <Row label="DMARC policy" ok={d.ok} neutral={d.neutral} okText={d.text} badText={d.text} />
                })()}
                {domainCheck.blocklists && domainCheck.blocklists.length > 0 && (() => {
                  const b = blocklistRow(domainCheck.blocklists)
                  return <Row label="Blocklists" ok={b.ok} neutral={b.neutral} okText={b.text} badText={b.text} />
                })()}
                {domainCheck.issues?.filter((i) => i.severity !== 'info').map((i) => (
                  <div key={i.code} style={{ color: i.severity === 'critical' ? colors.red : colors.textMuted, fontSize: 12 }}>
                    {i.message}
                  </div>
                ))}
                <div style={{ color: colors.textFaint, fontSize: 12, marginTop: 4 }}>
                  {monitor?.checkedAt
                    ? `Checked automatically every day · last run ${new Date(monitor.checkedAt).toLocaleString()}`
                    : 'Checked automatically every day · first scheduled run pending'}
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

          {/* Domain warmup */}
          {warmup && (
            <div style={{ ...s.cardInner }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: warmup.active ? 10 : 0 }}>
                <div style={{ color: colors.textFaint, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                  Domain Warmup
                </div>
                {canManage && onStartWarmup && (
                  <button
                    style={{ ...s.btnSecondary, fontSize: 12, padding: '4px 10px' }}
                    disabled={startingWarmup}
                    onClick={onStartWarmup}
                  >
                    {startingWarmup ? 'Starting…' : warmup.active ? 'Restart warmup' : 'Start warmup'}
                  </button>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ color: colors.textMuted, fontSize: 13 }}>Ramp status</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: !warmup.active ? colors.textFaint : warmup.complete ? colors.green : colors.amber }}>
                  {warmupHeadline(warmup)}
                </span>
              </div>
            </div>
          )}

          {/* Sender reputation */}
          {reputation && (
            <div style={{ ...s.cardInner }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                <div style={{ color: colors.textFaint, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                  Sender Reputation
                </div>
                <span style={{
                  fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
                  color: reputation.healthy ? colors.green : colors.red,
                  background: reputation.healthy ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
                }}>
                  {reputation.healthy ? 'HEALTHY' : `BLOCKED — ${reputation.reason === 'COMPLAINT_RATE_HIGH' ? 'complaint rate' : 'bounce rate'} too high`}
                </span>
              </div>
              {reputation.totalSends < reputation.thresholds.minSends ? (
                <div style={{ color: colors.textFaint, fontSize: 13 }}>
                  Not enough sends yet ({reputation.totalSends} of {reputation.thresholds.minSends} needed) to compute a reliable rate.
                </div>
              ) : (
                <div style={{ display: 'grid', gap: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ color: colors.textMuted, fontSize: 13 }}>Bounce rate (last {reputation.thresholds.windowDays}d)</span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: reputation.bounceRate > reputation.thresholds.maxBounceRate ? colors.red : colors.text }}>
                      {pct(reputation.bounceRate)} of {reputation.totalSends} sends
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ color: colors.textMuted, fontSize: 13 }}>Complaint rate</span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: reputation.complaintRate > reputation.thresholds.maxComplaintRate ? colors.red : colors.text }}>
                      {pct(reputation.complaintRate)}
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
