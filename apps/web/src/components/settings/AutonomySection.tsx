import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type { AutonomyStatus } from '@acaos/shared'
import { s, colors } from '../../styles.js'
import { makeRouteApi } from '../../lib/routeApi.js'
import type { ApiHook } from '../../hooks/useApi.js'
import type { ToastHook } from '../../hooks/useToast.js'

type Props = { api: ApiHook; workspaceId: string; toast: ToastHook; canManage: boolean }

const BLOCKER_TEXT: Record<string, string> = {
  MODE_OFF: 'Automatic sending is switched off for this ACAOS deployment',
  SENDING_DISABLED: 'Sending is paused platform-wide',
  SAFE_LAUNCH: 'Safe-launch mode is on, which always requires approval',
  WORKSPACE_SUPPRESSED: 'Sending is suspended for this workspace',
  NOT_OPTED_IN: 'This workspace has not opted in to automatic sending',
  REPUTATION_SAMPLE_LOW: 'Not enough sends yet to judge sender reputation',
  REPUTATION_UNHEALTHY: 'Bounce or complaint rate is too high',
  TOO_FEW_REVIEWED_DRAFTS: 'Not enough drafts have been reviewed by a person yet',
  APPROVAL_RATE_LOW: 'Too many reviewed drafts were rejected',
  POLICY_REVIEW_RATE_HIGH: 'Too many drafts were held for a policy review',
}

const pct = (x: number | null) => (x == null ? '—' : `${Math.round(x * 1000) / 10}%`)

// UQ-40: whether freshly generated outreach may send without a person
// approving it. Human approval stays the answer unless every condition holds.
export function AutonomySection({ api, workspaceId, toast, canManage }: Props) {
  const route = useMemo(() => makeRouteApi(api), [api])
  const [status, setStatus] = useState<AutonomyStatus | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    route('GET /api/workspaces/:id/autonomy', { params: { id: workspaceId } })
      .then(setStatus)
      .catch(() => toast.error('Failed to load automatic-sending status'))
  }, [route, workspaceId, toast])
  useEffect(() => { load() }, [load])

  async function setOptIn(optIn: boolean) {
    if (!status) return
    setBusy(true)
    try {
      const next = await route('PATCH /api/workspaces/:id/autonomy', {
        params: { id: workspaceId },
        body: optIn ? { optIn, consentVersion: status.consentVersion } : { optIn },
      })
      setStatus(next)
      toast.success(optIn ? 'Opted in — drafts still need approval until every condition is met' : 'Opted out — every draft now needs approval')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update automatic sending')
    } finally { setBusy(false) }
  }

  if (!status?.metrics || !status.thresholds) return null
  const m = status.metrics
  const t = status.thresholds
  const posture = status.ready && status.approvalModeOff ? 'AUTOMATIC' : 'HUMAN APPROVAL'
  return (
    <div style={s.cardInner}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <strong style={{ color: colors.text, fontSize: 14 }}>Automatic sending</strong>
        <span style={{ fontSize: 12, fontWeight: 700, color: posture === 'AUTOMATIC' ? colors.amber : colors.green }}>{posture}</span>
      </div>
      <div style={{ fontSize: 13, color: colors.textMuted, marginTop: 6 }}>
        Drafts send without a person approving them only when this workspace has opted in, approval mode is off, and every check below passes.
        Otherwise each draft waits in the Review Queue.
      </div>
      <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 8, display: 'grid', gap: 2 }}>
        <div>Reviewed drafts (90 days): {m.reviewedDrafts} of {t.minReviewedDrafts} needed</div>
        <div>Approval rate: {pct(m.approvalRate)} (needs {pct(t.minApprovalRate)}+) · Held for policy review: {pct(m.policyReviewRate)} (max {pct(t.maxPolicyReviewRate)})</div>
        <div>Sends: {m.sends} (needs {t.minSends}+) · Bounce rate {pct(m.bounceRate)} · Complaint rate {pct(m.complaintRate)}</div>
      </div>
      {status.blockers.length > 0 && (
        <ul aria-label="Automatic sending blockers" style={{ fontSize: 12, color: colors.textMuted, margin: '8px 0 0', paddingLeft: 18 }}>
          {status.blockers.map(b => <li key={b}>{BLOCKER_TEXT[b] ?? b}</li>)}
        </ul>
      )}
      {canManage && (
        <div style={{ marginTop: 10 }}>
          {status.optedIn
            ? <button style={s.btnGhost} disabled={busy} onClick={() => setOptIn(false)}>Opt out of automatic sending</button>
            : <button style={s.btnGhost} disabled={busy} onClick={() => setOptIn(true)}>Opt in to automatic sending</button>}
          {status.optedIn && status.optInAt && (
            <span style={{ fontSize: 12, color: colors.textFaint, marginLeft: 8 }}>Opted in {new Date(status.optInAt).toLocaleDateString()} (terms {status.consentVersion})</span>
          )}
        </div>
      )}
    </div>
  )
}
