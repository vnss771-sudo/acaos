import React, { useState } from 'react'
import type { RouteApi } from '../../lib/routeApi.js'
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
}

type Props = {
  route: RouteApi
  toast: ToastHook
  workspaceId: string
  // Which opportunity this prices: a Work-discovery one or a commercial one.
  target: { opportunityId: string } | { commercialOpportunityId: string }
  quote: QuoteSummary | null
  onChanged: () => void
}

export function QuoteCapture({ route, toast, workspaceId, target, quote, onChanged }: Props) {
  const targetId = 'opportunityId' in target ? target.opportunityId : target.commercialOpportunityId
  const [open, setOpen] = useState(false)
  const [amount, setAmount] = useState('')
  const [hours, setHours] = useState('')
  const [busy, setBusy] = useState(false)

  async function save() {
    const amountCents = parseDollars(amount)
    if (amountCents == null || Number.isNaN(amountCents)) { toast.error('Enter the quoted amount in dollars'); return }
    const h = hours.trim() === '' ? undefined : Number(hours)
    if (h !== undefined && (!Number.isFinite(h) || h < 0)) { toast.error('Estimated hours must be a number'); return }
    setBusy(true)
    try {
      await route('POST /api/delivery/quotes', { body: { workspaceId, ...target, amountCents, estimatedHours: h, submit: true } })
      toast.success('Quote recorded')
      setOpen(false); setAmount(''); setHours('')
      onChanged()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to record quote') }
    finally { setBusy(false) }
  }

  async function decide(status: 'ACCEPTED' | 'REJECTED') {
    if (!quote) return
    setBusy(true)
    try {
      await route('PATCH /api/delivery/quotes/:id/status', { params: { id: quote.id }, body: { workspaceId, status } })
      toast.success(status === 'ACCEPTED' ? 'Quote accepted — marked as won' : 'Quote marked as declined')
      onChanged()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to update quote') }
    finally { setBusy(false) }
  }

  if (quote && (quote.status === 'SUBMITTED' || quote.status === 'ACCEPTED')) {
    return (
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}>
        <span style={{ color: colors.textMuted }}>
          Quoted <strong style={{ color: colors.text }}>{formatCents(quote.amountCents)}</strong>
          {quote.estimatedHours != null && <> · {quote.estimatedHours} h estimated</>}
          {quote.status === 'ACCEPTED' && <span style={{ color: colors.green }}> · accepted</span>}
        </span>
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
      <button style={s.btnSm} disabled={busy} onClick={save}>Save quote</button>
      <button style={s.btnGhost} disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
    </div>
  )
}
