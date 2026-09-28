import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type { LearningRecommendationDto } from '@acaos/shared'
import { s, colors } from '../../styles.js'
import { makeRouteApi } from '../../lib/routeApi.js'
import type { ApiHook } from '../../hooks/useApi.js'
import type { ToastHook } from '../../hooks/useToast.js'

type Props = { api: ApiHook; workspaceId: string; toast: ToastHook; canManage: boolean }

type SegmentInsight = { segment: string; won: number; total: number; observedWinRate: number; adjustedWinRate: number; lift: number }

const pct = (x: unknown) => (typeof x === 'number' ? `${(x * 100).toFixed(1)}%` : '—')

const STATUS_LABEL: Record<string, string> = {
  APPROVED: 'Accepted', REJECTED: 'Rejected', REVERTED: 'Reverted', EXPIRED: 'Expired', APPLIED_AUTOMATICALLY: 'Applied automatically',
}

// Plain-language headline for a proposal: what would change, in customer terms.
export function describeRecommendation(r: LearningRecommendationDto): { title: string; from: string; to: string } {
  const list = (v: unknown) => (Array.isArray(v) && v.length ? v.join(', ') : 'none set')
  const size = (v: unknown) => {
    const o = (v ?? {}) as { minEmployees?: number | null; maxEmployees?: number | null }
    return o.minEmployees == null && o.maxEmployees == null ? 'any size' : `${o.minEmployees ?? '?'}–${o.maxEmployees ?? '?'} employees`
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
              <th>Industry</th><th>Wins / prospects</th><th>Observed</th><th>Adjusted</th><th>vs overall</th>
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

  const load = useCallback(() => {
    api<{ recommendations: LearningRecommendationDto[] }>(`/api/workspaces/${workspaceId}/learning-recommendations`)
      .then(d => setRecs(Array.isArray(d?.recommendations) ? d.recommendations : []))
      .catch(() => setRecs([]))
  }, [api, workspaceId])
  useEffect(() => { load() }, [load])

  async function act(r: LearningRecommendationDto, action: 'approve' | 'reject' | 'revert') {
    setBusyId(r.id)
    try {
      const params = { id: workspaceId, recId: r.id }
      if (action === 'approve') await route('POST /api/workspaces/:id/learning-recommendations/:recId/approve', { params })
      else if (action === 'reject') await route('POST /api/workspaces/:id/learning-recommendations/:recId/reject', { params })
      else await route('POST /api/workspaces/:id/learning-recommendations/:recId/revert', { params })
      toast.success(action === 'approve' ? 'Change applied' : action === 'reject' ? 'Recommendation dismissed' : 'Change reverted')
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
            const revertable = canManage && (r.status === 'APPROVED' || r.status === 'APPLIED_AUTOMATICALLY')
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
    </div>
  )
}
