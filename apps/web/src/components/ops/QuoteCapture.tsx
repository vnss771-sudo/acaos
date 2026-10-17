import React, { useEffect, useRef, useState } from 'react'
import type { RouteApi } from '../../lib/routeApi.js'
import type { ApiHook } from '../../hooks/useApi.js'
import type { EstimateInputs } from '@acaos/shared'
import { EstimateBuilder, type EstimateResult } from './EstimateBuilder.js'
import type { ToastHook } from '../../hooks/useToast.js'
import { colors, s } from '../../styles.js'
import { formatCents, parseDollars } from '../../lib/money.js'

// Phase 15B: capture the quote at the moment the work is being pursued, not in
// a separate accounting screen. Admin-only (the parent decides). One live quote
// per card: a revision means "declined/withdrawn" then a new quote.

export type QuoteSummary = {
  id: string
  opportunityId: string | null
  commercialOpportunityId?: string | null
  status: 'DRAFT' | 'SUBMITTED' | 'ACCEPTED' | 'REJECTED' | 'WITHDRAWN'
  amountCents: number
  estimatedHours: number | null
  // The delivery job this quote became, once started.
  job?: { id: string; status: string } | null
  // The estimate snapshot the server stored when the quote was saved (Quote.estimate); null = none built.
  estimate?: SavedEstimate | null
}

// Quote.estimate as stored by POST /api/delivery/quotes: the figures as they were
// at save time. Shown as saved, never recomputed with today's rates.
export type SavedEstimate = {
  version: number
  computedAt: string
  result: Pick<EstimateResult,
    'labourCostCents' | 'labourIncludesOnCosts' | 'materialsCents' | 'subcontractCents' | 'overheadCents' | 'directCostCents'
    | 'priceCents' | 'grossMarginCents' | 'grossMarginPct' | 'marginAfterOverheadsCents' | 'marginAfterOverheadsPct'>
}

/** A stored figure: "not entered" when unknown, never $0; an entered 0 is $0. */
const saved = (cents: number | null | undefined) => (cents == null ? 'not entered' : formatCents(cents))

/** Read-only summary of the estimate a quote was saved with. Renders nothing for a quote without one. */
export function SavedEstimateSummary({ estimate }: { estimate: SavedEstimate | null | undefined }) {
  const r = estimate?.result
  if (!estimate || !r) return null
  const date = new Date(estimate.computedAt)
  const when = Number.isNaN(date.getTime()) ? '' : ` on ${date.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })}`
  return (
    <div role="region" aria-label="Saved estimate" style={{ flexBasis: '100%', display: 'grid', gap: 2, fontSize: 12, color: colors.textMuted }}>
      <span>
        Estimate saved with this quote{when}: labour <strong>{saved(r.labourCostCents)}</strong>{r.labourCostCents != null && !r.labourIncludesOnCosts ? ' (base pay only)' : ''}
        {' · '}materials <strong>{saved(r.materialsCents)}</strong>
        {' · '}subcontractors <strong>{saved(r.subcontractCents)}</strong>
        {' · '}overheads <strong>{saved(r.overheadCents)}</strong>
      </span>
      {r.grossMarginCents != null
        ? <span style={{ color: r.grossMarginCents < 0 ? colors.red : colors.text }}>
            At the quoted {formatCents(r.priceCents)}: gross profit <strong>{formatCents(r.grossMarginCents)}</strong> ({r.grossMarginPct == null ? '—' : `${r.grossMarginPct}%`} gross margin)
            {r.marginAfterOverheadsCents != null && <> · after overheads {formatCents(r.marginAfterOverheadsCents)}{r.marginAfterOverheadsPct == null ? '' : ` (${r.marginAfterOverheadsPct}%)`}</>}
          </span>
        : <span>Gross profit unknown: not every direct cost was entered when the quote was saved.</span>}
      <span style={{ color: colors.textFaint }}>Figures as saved, not recalculated.</span>
    </div>
  )
}

// GET /api/delivery/estimate-check: how recent comparable closed jobs landed
// against their estimated hours. Advisory; null basis = too few jobs to say.
export type EstimateCheck = {
  minJobs: number
  basis: 'SAME_ORIGIN' | 'ALL_JOBS' | null
  sameOriginJobs: number
  scopeChangedJobs: number
  direction: 'OVER' | 'UNDER' | 'ON_TARGET' | null
  hoursFactor: number | null
  message: string | null
}

/** The hours an estimate becomes at the track record, or null when there's nothing to adjust. */
export function adjustedHours(hours: string, check: Pick<EstimateCheck, 'hoursFactor'> | null): number | null {
  const h = Number(hours)
  if (!check?.hoursFactor || hours.trim() === '' || !Number.isFinite(h) || h <= 0) return null
  return Math.round(h * check.hoursFactor)
}

type Props = {
  route: RouteApi
  // Raw GET client for the estimate check; without it the form shows no check.
  api?: ApiHook
  toast: ToastHook
  workspaceId: string
  // Which opportunity this prices: a Work-discovery one or a commercial one.
  target: { opportunityId: string } | { commercialOpportunityId: string }
  quote: QuoteSummary | null
  onChanged: () => void
  // After a decision (e.g. keep a won card in view) — defaults to onChanged.
  onDecided?: (status: 'ACCEPTED' | 'REJECTED') => void
  // Take the user to the job (Jobs & margins).
  onOpenJob?: () => void
}

/** Where this work sits between finding it and delivering it, from persisted state only. */
export function quoteLifecycleCue(quote: Pick<QuoteSummary, 'status' | 'job'>): string | null {
  if (quote.status === 'SUBMITTED') return 'Opportunity → quote sent → awaiting decision'
  if (quote.status !== 'ACCEPTED') return null
  if (!quote.job) return 'Opportunity → quote → won → ready to start'
  if (quote.job.status === 'COMPLETE') return 'Opportunity → quote → won → job complete'
  if (quote.job.status === 'CANCELLED') return 'Opportunity → quote → won → job cancelled'
  return 'Opportunity → quote → won → job in delivery'
}

// With the phone keyboard open, a tap first blurs the input and the layout jumps as
// the keyboard closes, so the click can miss. Keeping focus through the press lets
// the tap land on Save; the form then closes and the keyboard with it.
const keepFocus = (e: React.MouseEvent) => e.preventDefault()

export function QuoteCapture({ route, api, toast, workspaceId, target, quote, onChanged, onDecided, onOpenJob }: Props) {
  const targetKey = 'opportunityId' in target ? 'opportunityId' : 'commercialOpportunityId'
  const targetId = 'opportunityId' in target ? target.opportunityId : target.commercialOpportunityId
  const [open, setOpen] = useState(false)
  const [amount, setAmount] = useState('')
  const [hours, setHours] = useState('')
  const [busy, setBusy] = useState(false)
  const [check, setCheck] = useState<EstimateCheck | null>(null)
  const [estimating, setEstimating] = useState(false)
  const [estimate, setEstimate] = useState<EstimateInputs | null>(null)
  // Both Save buttons share save(); this stops a double tap posting twice before
  // `busy` has re-rendered the buttons as disabled.
  const submitting = useRef(false)

  // Fetched when the form opens. Advisory: a failure just means no check shown.
  useEffect(() => {
    if (!open || !api) return
    let live = true
    api<{ check: EstimateCheck }>(`/api/delivery/estimate-check?workspaceId=${encodeURIComponent(workspaceId)}&${targetKey}=${encodeURIComponent(targetId)}`)
      .then(r => { if (live) setCheck(r.check) })
      .catch(() => { if (live) setCheck(null) })
    return () => { live = false }
  }, [open, api, workspaceId, targetKey, targetId])
  const suggested = adjustedHours(hours, check)

  async function save() {
    if (submitting.current) return
    const amountCents = parseDollars(amount)
    if (amountCents == null || Number.isNaN(amountCents)) { toast.error('Enter the quoted amount in dollars'); return }
    const h = hours.trim() === '' ? undefined : Number(hours)
    if (h !== undefined && (!Number.isFinite(h) || h < 0)) { toast.error('Estimated hours must be a number'); return }
    submitting.current = true
    setBusy(true)
    try {
      // The estimate travels as inputs only; the server recomputes and stores it. The amount and hours are as typed.
      const withEstimate = estimating && estimate ? { estimate } : {}
      await route('POST /api/delivery/quotes', { body: { workspaceId, ...target, amountCents, estimatedHours: h, submit: true, ...withEstimate } })
      toast.success('Quote recorded')
      setOpen(false); setAmount(''); setHours(''); setEstimating(false); setEstimate(null)
      onChanged()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to record quote') }
    finally { submitting.current = false; setBusy(false) }
  }

  async function decide(status: 'ACCEPTED' | 'REJECTED') {
    if (!quote) return
    setBusy(true)
    try {
      await route('PATCH /api/delivery/quotes/:id/status', { params: { id: quote.id }, body: { workspaceId, status } })
      toast.success(status === 'ACCEPTED' ? 'Won it — start the job when you\'re ready' : 'Quote marked as declined')
      if (onDecided) onDecided(status)
      else onChanged()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to update quote') }
    finally { setBusy(false) }
  }

  async function startJob() {
    if (!quote) return
    setBusy(true)
    try {
      await route('POST /api/delivery/quotes/:id/job', { params: { id: quote.id }, body: { workspaceId } })
      toast.success('Job started — add your crew and log shifts against it')
      onChanged()
      onOpenJob?.()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to start the job') }
    finally { setBusy(false) }
  }

  if (quote && (quote.status === 'SUBMITTED' || quote.status === 'ACCEPTED')) {
    const cue = quoteLifecycleCue(quote)
    return (
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}>
        {cue && <span style={{ flexBasis: '100%', fontSize: 12, color: colors.textFaint }}>{cue}</span>}
        <span style={{ color: colors.textMuted }}>
          Quoted <strong style={{ color: colors.text }}>{formatCents(quote.amountCents)}</strong>
          {quote.estimatedHours != null && <> · {quote.estimatedHours} h estimated</>}
          {quote.status === 'ACCEPTED' && <span style={{ color: colors.green }}> · accepted</span>}
        </span>
        <SavedEstimateSummary estimate={quote.estimate} />
        {quote.status === 'ACCEPTED' && !quote.job && (
          <button style={s.btnSm} disabled={busy} onClick={startJob}>Start the job</button>
        )}
        {quote.status === 'ACCEPTED' && quote.job && (
          <>
            <span style={{ color: colors.green }}>✓ Job started</span>
            {onOpenJob && <button style={s.btnGhost} onClick={onOpenJob}>Open job</button>}
          </>
        )}
        {quote.status === 'SUBMITTED' && (
          <>
            <button style={s.btnSm} disabled={busy} onClick={() => decide('ACCEPTED')}>Client accepted</button>
            <button style={s.btnGhost} disabled={busy} onClick={() => decide('REJECTED')}>Client declined</button>
          </>
        )}
      </div>
    )
  }

  if (!open) return <button style={s.btnGhost} onClick={() => setOpen(true)}>Record quote</button>

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
      <div>
        <label style={s.label} htmlFor={`q-amt-${targetId}`}>Quote amount ($)</label>
        <input id={`q-amt-${targetId}`} style={{ ...s.input, width: 140 }} inputMode="decimal" value={amount} placeholder="60,000" onChange={e => setAmount(e.target.value)} />
      </div>
      <div>
        <label style={s.label} htmlFor={`q-hrs-${targetId}`}>Estimated labour hours</label>
        <input id={`q-hrs-${targetId}`} style={{ ...s.input, width: 120 }} inputMode="decimal" value={hours} placeholder="400" onChange={e => setHours(e.target.value)} />
      </div>
      <button type="button" style={s.btnSm} disabled={busy} onMouseDown={keepFocus} onClick={save}>Save quote</button>
      <button style={s.btnGhost} disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
      {!estimating && <button style={s.btnGhost} disabled={busy} onClick={() => setEstimating(true)}>Build estimate</button>}
      {estimating && (
        <EstimateBuilder
          route={route} workspaceId={workspaceId} target={target} priceCents={parseDollars(amount)} hours={hours}
          onUsePrice={cents => setAmount((cents / 100).toFixed(2))} onInputs={setEstimate}
        />
      )}
      {/* On a phone the builder pushes the top Save out of view; this one saves the same way. */}
      {estimating && (
        <div style={{ flexBasis: '100%' }}>
          <button type="button" data-testid="save-quote-bottom" style={s.btnSm} disabled={busy} onMouseDown={keepFocus} onClick={save}>Save quote</button>
        </div>
      )}
      {check && (
        <div role="note" aria-label="Estimate check" style={{ flexBasis: '100%', fontSize: 12, color: check.direction === 'OVER' || check.direction === 'UNDER' ? colors.amber : colors.textFaint }}>
          {check.message ?? `Estimate check: ${check.sameOriginJobs} of ${check.minJobs} closed jobs needed before your estimates are compared with your track record.`}
          {suggested != null && <> At that record, {hours.trim()} h is closer to <strong>{suggested} h</strong>.</>}
          {check.message && check.scopeChangedJobs > 0 && <span style={{ color: colors.textFaint }}> ({check.scopeChangedJobs} job(s) with approved variations left out.)</span>}
        </div>
      )}
    </div>
  )
}
