import React, { useState } from 'react'
import { colors, s } from '../../styles.js'
import { Badge } from '../ui/Badge.js'
import { formatCents, parseDollars } from '../../lib/money.js'
import type { RouteApi } from '../../lib/routeApi.js'
import type { ToastHook } from '../../hooks/useToast.js'

export type JobVariation = {
  id: string; title: string; description: string | null
  revenueCents: number | null; estimatedCostCents: number | null; estimatedHours: number | null
  status: 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'CANCELLED'
  submittedAt: string | null; decidedAt: string | null; createdAt: string
}

const STATUS_COLOR: Record<JobVariation['status'], string> = {
  DRAFT: colors.textFaint, SUBMITTED: colors.amber, APPROVED: colors.green, REJECTED: colors.red, CANCELLED: colors.textFaint,
}

/** Dollars that may be negative (a scope reduction): "-1,200" → -120000. */
function parseSignedDollars(input: string): number | null {
  const t = input.trim()
  const neg = t.startsWith('-')
  const v = parseDollars(neg ? t.slice(1) : t)
  return v == null || Number.isNaN(v) ? v : neg ? -v : v
}

type Props = {
  jobId: string; jobActive: boolean; variations: JobVariation[]; workspaceId: string
  route: RouteApi; toast: ToastHook; onChanged: () => void; isMobile: boolean
}

// UQ-35: scope changes on a job. The accepted quote is never rewritten; only an
// APPROVED variation adjusts the contract value. A closed job must be reopened
// before its variations change.
export function JobVariations({ jobId, jobActive, variations, workspaceId, route, toast, onChanged, isMobile }: Props) {
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ title: '', price: '', cost: '', hours: '' })
  const [busy, setBusy] = useState(false)
  const tap: React.CSSProperties = isMobile ? { minHeight: 44 } : {}
  const pending = variations.filter(v => v.status === 'SUBMITTED').length

  async function create(submit: boolean) {
    const revenueCents = parseSignedDollars(form.price)
    const estimatedCostCents = parseDollars(form.cost)
    const estimatedHours = form.hours.trim() === '' ? null : Number(form.hours)
    if (!form.title.trim()) { toast.error('Say what the variation is'); return }
    if (Number.isNaN(revenueCents) || Number.isNaN(estimatedCostCents) || (estimatedHours != null && (!Number.isFinite(estimatedHours) || estimatedHours < 0))) {
      toast.error('Enter amounts in dollars and hours as a number, or leave them blank'); return
    }
    setBusy(true)
    try {
      await route('POST /api/delivery/jobs/:id/variations', {
        params: { id: jobId },
        body: { workspaceId, title: form.title.trim(), revenueCents, estimatedCostCents, estimatedHours, submit },
      })
      toast.success(submit ? 'Variation submitted for approval' : 'Variation saved as a draft')
      setAdding(false); setForm({ title: '', price: '', cost: '', hours: '' })
      onChanged()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to record the variation') }
    finally { setBusy(false) }
  }

  async function move(v: JobVariation, status: 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'CANCELLED') {
    setBusy(true)
    try {
      await route('PATCH /api/delivery/variations/:id/status', { params: { id: v.id }, body: { workspaceId, status } })
      toast.success(`Variation ${status.toLowerCase()}`)
      onChanged()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to update the variation') }
    finally { setBusy(false) }
  }

  if (!variations.length && !jobActive) return null
  return (
    <div style={{ margin: '4px 0 10px' }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: colors.textMuted, marginBottom: 4 }}>
        Variations{pending ? ` · ${pending} awaiting approval` : ''}
      </div>
      {variations.map(v => (
        <div key={v.id} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: 13, padding: '4px 0', borderTop: `1px solid ${colors.borderLight}` }}>
          <Badge color={STATUS_COLOR[v.status]}>{v.status.toLowerCase()}</Badge>
          <span style={{ color: colors.text, flex: 1, minWidth: 140 }}>{v.title}</span>
          <span style={{ color: colors.textMuted }}>
            {v.revenueCents == null ? 'unpriced' : `${v.revenueCents >= 0 ? '+' : ''}${formatCents(v.revenueCents)}`}
            {v.estimatedCostCents != null ? ` · est. cost ${formatCents(v.estimatedCostCents)}` : ''}
            {v.estimatedHours != null ? ` · ${v.estimatedHours} h` : ''}
          </span>
          {jobActive && v.status === 'DRAFT' && <button style={{ ...s.btnGhost, ...tap }} disabled={busy} onClick={() => move(v, 'SUBMITTED')}>Submit</button>}
          {jobActive && v.status === 'SUBMITTED' && <>
            <button style={{ ...s.btnSm, ...tap }} disabled={busy} onClick={() => move(v, 'APPROVED')}>Approve</button>
            <button style={{ ...s.btnGhost, ...tap }} disabled={busy} onClick={() => move(v, 'REJECTED')}>Reject</button>
          </>}
          {jobActive && (v.status === 'DRAFT' || v.status === 'SUBMITTED') && (
            <button style={{ ...s.btnGhost, ...tap }} disabled={busy} onClick={() => move(v, 'CANCELLED')}>Cancel</button>
          )}
        </div>
      ))}
      {jobActive && !adding && <button style={{ ...s.btnGhost, ...tap, marginTop: 4 }} onClick={() => setAdding(true)}>Record a variation</button>}
      {jobActive && adding && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: isMobile ? 'stretch' : 'flex-end', flexDirection: isMobile ? 'column' : 'row', marginTop: 6 }}>
          <div style={{ flex: 1, minWidth: 180 }}>
            <label style={s.label} htmlFor={`var-title-${jobId}`}>What changed</label>
            <input id={`var-title-${jobId}`} style={{ ...s.input, width: '100%' }} value={form.title} placeholder="e.g. Extra sub-board in the warehouse" onChange={e => setForm(f => ({ ...f, title: e.target.value }))} />
          </div>
          <div>
            <label style={s.label} htmlFor={`var-price-${jobId}`}>Price change ($)</label>
            <input id={`var-price-${jobId}`} style={{ ...s.input, width: isMobile ? '100%' : 120 }} inputMode="decimal" value={form.price} placeholder="-500 for less" onChange={e => setForm(f => ({ ...f, price: e.target.value }))} />
          </div>
          <div>
            <label style={s.label} htmlFor={`var-cost-${jobId}`}>Est. cost ($)</label>
            <input id={`var-cost-${jobId}`} style={{ ...s.input, width: isMobile ? '100%' : 110 }} inputMode="decimal" value={form.cost} placeholder="unknown" onChange={e => setForm(f => ({ ...f, cost: e.target.value }))} />
          </div>
          <div>
            <label style={s.label} htmlFor={`var-hours-${jobId}`}>Est. hours</label>
            <input id={`var-hours-${jobId}`} style={{ ...s.input, width: isMobile ? '100%' : 80 }} inputMode="decimal" value={form.hours} placeholder="unknown" onChange={e => setForm(f => ({ ...f, hours: e.target.value }))} />
          </div>
          <button style={{ ...s.btnSm, ...tap }} disabled={busy} onClick={() => create(true)}>Submit for approval</button>
          <button style={{ ...s.btnGhost, ...tap }} disabled={busy} onClick={() => create(false)}>Save draft</button>
          <button style={{ ...s.btnGhost, ...tap }} disabled={busy} onClick={() => setAdding(false)}>Cancel</button>
        </div>
      )}
    </div>
  )
}
