import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type { LearningRecommendationDto } from '@acaos/shared'
import { s, colors } from '../../styles.js'
import { makeRouteApi } from '../../lib/routeApi.js'
import type { ApiHook } from '../../hooks/useApi.js'
import type { ToastHook } from '../../hooks/useToast.js'

type Props = { api: ApiHook; workspaceId: string; toast: ToastHook; canManage: boolean }

type GroupStats = { leads: number; replied: number; converted: number; replyRate: number; conversionRate: number }
type HoldoutComparison = { holdoutPercent: number; contacted: GroupStats; heldOut: GroupStats; conversionLiftPts: number | null }

// Contacted vs held-back comparison group: the fair baseline that shows
// whether outreach (and learning-driven outreach) actually improves results.
function HoldoutPanel({ h }: { h: HoldoutComparison }) {
  const row = (label: string, g: GroupStats) => (
    <tr><td>{label}</td><td>{g.leads}</td><td>{g.replyRate}%</td><td>{g.conversionRate}%</td></tr>
  )
  return (
    <div style={{ ...s.cardInner, fontSize: 12, color: colors.textMuted, marginTop: 12 }}>
      <div style={{ fontWeight: 600, color: colors.text, marginBottom: 4 }}>Comparison group</div>
      <div>
        {h.holdoutPercent > 0
          ? `${h.holdoutPercent}% of leads are picked at random and held back from campaigns, as a fair baseline.`
          : 'Off — no leads are being held back. Set LEARNING_HOLDOUT_PERCENT to measure lift (5% is used automatically once learning is live).'}
      </div>
      {(h.contacted.leads > 0 || h.heldOut.leads > 0) && (
        <table style={{ marginTop: 8, borderCollapse: 'collapse', width: '100%' }}>
          <thead><tr style={{ textAlign: 'left', color: colors.textFaint }}><th>Group</th><th>Leads</th><th>Replied</th><th>Booked / closed</th></tr></thead>
          <tbody>{row('Contacted', h.contacted)}{row('Held back', h.heldOut)}</tbody>
        </table>
      )}
      {h.conversionLiftPts != null && <div style={{ marginTop: 6 }}>Lift: <strong>{h.conversionLiftPts > 0 ? '+' : ''}{h.conversionLiftPts} pts</strong> booked/closed rate vs the held-back group.</div>}
    </div>
  )
}

type SegmentInsight = { segment: string; won: number; total: number; observedWinRate: number; adjustedWinRate: number; lift: number }

const pct = (x: unknown) => (typeof x === 'number' ? `${(x * 100).toFixed(1)}%` : '—')

const STATUS_LABEL: Record<string, string> = {
  APPROVED: 'Accepted', REJECTED: 'Rejected', REVERTED: 'Reverted', EXPIRED: 'Expired', APPLIED_AUTOMATICALLY: 'Applied automatically',
}

// Advisory proposals (closed-loop learning): accepting acknowledges them; nothing changes.
const ADVISORY = new Set(['OPPORTUNITY_CAUSE'])
const CAUSE_LABEL: Record<string, string> = {
  LOST_TO_COMPETITOR: 'Lost to a competitor', WRONG_CONTACT: 'Wrong contact', WRONG_TIMING: 'Wrong timing',
  WRONG_SIGNAL: 'Wrong signal', BAD_MESSAGE: 'Message didn\'t land',
}

// Plain-language headline for a proposal: what would change, in customer terms.
function describeRecommendation(r: LearningRecommendationDto): { title: string; from: string; to: string } {
  const list = (v: unknown) => (Array.isArray(v) && v.length ? v.join(', ') : 'none set')
  const size = (v: unknown) => {
    const o = (v ?? {}) as { minEmployees?: number | null; maxEmployees?: number | null }
    return o.minEmployees == null && o.maxEmployees == null ? 'any size' : `${o.minEmployees ?? '?'}–${o.maxEmployees ?? '?'} employees`
  }
  if (r.type === 'OPPORTUNITY_CAUSE') {
    const findings = ((r.proposedValue ?? {}) as { findings?: Array<{ cause: string; dimension: string; value: string; advice: string }> }).findings ?? []
    const dim = (d: string) => (d === 'offerKey' ? 'offer' : d === 'buyingStage' ? 'buying stage' : 'event')
    const top = findings[0]
    return {
      title: top ? `${top.advice}${findings.length > 1 ? ` (+${findings.length - 1} more)` : ''}` : 'Review why opportunities closed or stalled',
      from: findings.map(f => `${CAUSE_LABEL[f.cause] ?? f.cause} for ${dim(f.dimension)} ${f.value}`).join('; ') || 'no repeated cause',
      to: 'advisory — accepting changes nothing',
    }
  }
  if (r.type === 'ICP_INDUSTRY') return { title: 'Focus on the industries that are converting best', from: list(r.currentValue), to: list(r.proposedValue) }
  if (r.type === 'ICP_SIZE') return { title: 'Adjust the company size you target', from: size(r.currentValue), to: size(r.proposedValue) }
  const n = Object.keys((r.proposedValue ?? {}) as object).length
  return { title: 'Re-weight buying signals by how often they led to wins', from: 'current signal weights', to: `${n} adjusted signal weight${n === 1 ? '' : 's'}` }
}

function Evidence({ r }: { r: LearningRecommendationDto }) {
  const e = r.evidence as {
    totalOutcomes?: number; baselineWinRate?: number; industries?: SegmentInsight[]; basis?: string; method?: string
    confidence?: string; recencyHalfLifeDays?: number; calibrationVersion?: number
  }
  if (ADVISORY.has(r.type)) {
    return (
      <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 8 }}>
        <div>{e.basis ?? `Based on ${r.sampleSize} closed or stalled opportunities`}</div>
        <div style={{ marginTop: 2 }}>{` Proposed ${new Date(r.createdAt).toLocaleDateString()}`}</div>
      </div>
    )
  }
  return (
    <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 8 }}>
      <div>Based on {e.totalOutcomes ?? r.sampleSize} recorded wins/losses · overall win rate {pct(e.baselineWinRate)}</div>
      <div style={{ marginTop: 2 }}>
        Confidence: <strong>{e.confidence ?? '—'}</strong>
        {e.recencyHalfLifeDays ? ` · recent outcomes count more (half-weight after ${e.recencyHalfLifeDays} days)` : ''}
        {e.calibrationVersion ? ` · method v${e.calibrationVersion}` : ''}
        {` · proposed ${new Date(r.createdAt).toLocaleDateString()}`}
      </div>
      {(e.basis || e.method) && <div style={{ marginTop: 2 }}>{e.basis ?? e.method}</div>}
      {Array.isArray(e.industries) && e.industries.length > 0 && (
        <table style={{ marginTop: 8, borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr style={{ textAlign: 'left', color: colors.textFaint }}>
              <th>Industry</th><th>Wins / potential clients</th><th>Observed</th><th>Adjusted</th><th>vs overall</th>
            </tr>
          </thead>
          <tbody>
            {e.industries.slice(0, 6).map(i => (
              <tr key={i.segment}>
                <td>{i.segment}</td><td>{i.won} / {i.total}</td><td>{pct(i.observedWinRate)}</td>
                <td>{pct(i.adjustedWinRate)}</td><td>{i.lift.toFixed(2)}×</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div style={{ marginTop: 6, color: colors.textFaint }}>
        Adjusted rates are pulled toward the overall rate for small samples, so a lucky streak can't dominate. These are correlations, not proof of cause.
      </div>
    </div>
  )
}

// "What ACAOS is learning": proposals from the learning loop, with evidence.
// Nothing here changes your strategy until someone with ICP-edit rights accepts
// it — and accepted changes can be reverted.
export function LearningSection({ api, workspaceId, toast, canManage }: Props) {
  const route = useMemo(() => makeRouteApi(api), [api])
  const [recs, setRecs] = useState<LearningRecommendationDto[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [openEvidence, setOpenEvidence] = useState<string | null>(null)
  const [holdout, setHoldout] = useState<HoldoutComparison | null>(null)

  const load = useCallback(() => {
    api<{ recommendations: LearningRecommendationDto[] }>(`/api/workspaces/${workspaceId}/learning-recommendations`)
      .then(d => setRecs(Array.isArray(d?.recommendations) ? d.recommendations : []))
      .catch(() => setRecs([]))
  }, [api, workspaceId])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    api<HoldoutComparison>(`/api/workspaces/${workspaceId}/learning/holdout`)
      .then(d => setHoldout(d && d.contacted && d.heldOut ? d : null))
      .catch(() => setHoldout(null))
  }, [api, workspaceId])

  async function act(r: LearningRecommendationDto, action: 'approve' | 'reject' | 'revert') {
    setBusyId(r.id)
    try {
      const params = { id: workspaceId, recId: r.id }
      if (action === 'approve') await route('POST /api/workspaces/:id/learning-recommendations/:recId/approve', { params })
      else if (action === 'reject') await route('POST /api/workspaces/:id/learning-recommendations/:recId/reject', { params })
      else await route('POST /api/workspaces/:id/learning-recommendations/:recId/revert', { params })
      toast.success(action === 'approve' ? (ADVISORY.has(r.type) ? 'Noted' : 'Change applied') : action === 'reject' ? 'Recommendation dismissed' : 'Change reverted')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Action failed')
    } finally {
      setBusyId(null)
      load()
    }
  }

  const pending = (recs ?? []).filter(r => r.status === 'PENDING' && !r.expired)
  const history = (recs ?? []).filter(r => r.status !== 'PENDING').slice(0, 10)

  return (
    <div style={s.card}>
      <div style={s.sectionHeader}>What ACAOS is learning</div>
      <div style={{ color: colors.textMuted, fontSize: 13, marginBottom: 12, lineHeight: 1.5 }}>
        As deals are won and lost, ACAOS looks for patterns and suggests changes here. Nothing changes until you accept it, and accepted changes can be undone.
      </div>

      {recs === null && <div style={{ color: colors.textFaint, fontSize: 13 }}>Loading…</div>}
      {recs !== null && pending.length === 0 && (
        <div style={{ color: colors.textFaint, fontSize: 13 }}>
          No suggestions right now. ACAOS needs at least 10 recorded wins/losses before it suggests anything — until then it keeps using your settings as they are.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {pending.map(r => {
          const d = describeRecommendation(r)
          return (
            <div key={r.id} style={s.cardInner}>
              <div style={{ color: colors.text, fontSize: 14, fontWeight: 600 }}>{d.title}</div>
              <div style={{ fontSize: 13, color: colors.textMuted, marginTop: 4 }}>
                <span>Now: {d.from}</span> <span aria-hidden="true">→</span> <span style={{ color: colors.text }}>Suggested: {d.to}</span>
              </div>
              {openEvidence === r.id && <Evidence r={r} />}
              <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                {canManage && (
                  <>
                    <button style={s.btn} disabled={busyId === r.id} onClick={() => act(r, 'approve')}>Accept</button>
                    <button style={s.btnGhost} disabled={busyId === r.id} onClick={() => act(r, 'reject')}>Reject</button>
                  </>
                )}
                <button style={s.btnGhost} onClick={() => setOpenEvidence(openEvidence === r.id ? null : r.id)}>
                  {openEvidence === r.id ? 'Hide evidence' : 'Review evidence'}
                </button>
              </div>
            </div>
          )
        })}
      </div>

      {history.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ color: colors.textFaint, fontSize: 12, fontWeight: 700, marginBottom: 6 }}>History</div>
          {history.map(r => {
            const d = describeRecommendation(r)
            const revertable = canManage && !ADVISORY.has(r.type) && (r.status === 'APPROVED' || r.status === 'APPLIED_AUTOMATICALLY')
            return (
              <div key={r.id} style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 12, color: colors.textMuted, padding: '4px 0' }}>
                <span style={{ flex: 1 }}>{d.title} — {STATUS_LABEL[r.status] ?? r.status}{r.decidedAt ? ` ${new Date(r.decidedAt).toLocaleDateString()}` : ''}</span>
                {revertable && (
                  <button style={{ ...s.btnGhost, fontSize: 12, padding: '3px 8px' }} disabled={busyId === r.id} onClick={() => act(r, 'revert')}>
                    Revert
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
      {holdout && <HoldoutPanel h={holdout} />}
    </div>
  )
}
