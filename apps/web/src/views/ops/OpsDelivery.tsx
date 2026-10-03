import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApiHook } from '../../hooks/useApi.js'
import type { ToastHook } from '../../hooks/useToast.js'
import type { View, Workspace } from '../../types.js'
import { colors, s } from '../../styles.js'
import { makeRouteApi } from '../../lib/routeApi.js'
import { formatCents, formatPct, parseDollars } from '../../lib/money.js'
import { Card } from '../../components/ui/Card.js'
import { Badge } from '../../components/ui/Badge.js'
import { EmptyState } from '../../components/ui/EmptyState.js'
import { ErrorBanner } from '../../components/ui/ErrorBanner.js'
import { Skeleton } from '../../components/ui/Skeleton.js'
import { OpsSubNav } from '../../components/ops/OpsSubNav.js'

// "Jobs & margins" (phase 15B): what each job was quoted at vs what it delivered,
// closeout at the moment the job is done, and — once enough jobs are closed —
// which kinds of work actually make money. Admin-only: rates and margins.
// Unknowns are shown as unknown with the reason, never as $0.

type Props = { api: ApiHook; workspace: Workspace | null; toast: ToastHook; canManage?: boolean; setView: (v: View) => void }

type Economics = {
  actualHours: number; openShifts: number; rateCoverage: number | null; onCostPct: number
  labourCostCents: number | null; otherCostCents: number | null; revenueCents: number | null
  quotedCents: number | null; estimatedHours: number | null
  hoursVariancePct: number | null; revenueVsQuotePct: number | null
  labourMarginCents: number | null; labourMarginPct: number | null
  grossMarginCents: number | null; grossMarginPct: number | null
  marginBasis: 'GROSS' | 'LABOUR' | 'UNKNOWN'; gaps: string[]
}

type DeliveryJob = {
  id: string; status: 'ACTIVE' | 'COMPLETE' | 'CANCELLED'; closeoutVersion: number
  invoicedRevenueCents: number | null; otherCostCents: number | null
  site: { id: string; jobCode: string; siteName: string }
  quote: { id: string; amountCents: number; estimatedHours: number | null } | null
  origin: { type: string; kind: string; title: string } | null
  economics: Economics | null; economicsFrozen: boolean
  shiftsAfterCloseout?: number
}

type Stat = { n: number; median: number; min: number; max: number } | null
type ReportGroup = { key: string; label: string; jobs: number; hoursVariancePct: Stat; revenueVsQuotePct: Stat; labourMarginPct: Stat; grossMarginPct: Stat }
type Report = { minJobs: number; overall: ReportGroup; groups: ReportGroup[] }

const BASIS_LABEL: Record<Economics['marginBasis'], string> = { GROSS: 'Gross margin', LABOUR: 'Labour margin only', UNKNOWN: 'Margin unknown' }

function statText(st: Stat, pct = true): string {
  if (!st) return '—'
  const f = (v: number) => (pct ? `${v}%` : String(v))
  return `${f(st.median)} (n=${st.n}, ${f(st.min)} to ${f(st.max)})`
}

function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div style={{ minWidth: 120 }}>
      <div style={{ fontSize: 11, color: colors.textFaint, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 15, color: colors.text, fontWeight: 600 }}>{value}</div>
      {hint && <div style={{ fontSize: 11, color: colors.textMuted }}>{hint}</div>}
    </div>
  )
}

type CloseoutForm = { revenue: string; other: string; onCost: string }

export function OpsDelivery({ api, workspace, toast, canManage = false, setView }: Props) {
  const route = useMemo(() => makeRouteApi(api), [api])
  const [jobs, setJobs] = useState<DeliveryJob[] | null>(null)
  const [report, setReport] = useState<Report | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [closing, setClosing] = useState<string | null>(null)
  const [form, setForm] = useState<CloseoutForm>({ revenue: '', other: '', onCost: '' })
  const [reopening, setReopening] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  const reqRef = useRef(0)
  const load = useCallback(() => {
    if (!workspace || !canManage) return
    const reqId = ++reqRef.current
    setLoading(true)
    setLoadError(false)
    Promise.all([
      api<{ jobs: DeliveryJob[] }>(`/api/delivery/jobs?workspaceId=${workspace.id}`),
      api<{ report: Report }>(`/api/delivery/report?workspaceId=${workspace.id}`),
    ])
      .then(([j, r]) => {
        if (reqId !== reqRef.current) return
        setJobs(j.jobs)
        setReport(r.report)
      })
      .catch(e => {
        if (reqId !== reqRef.current) return
        toast.error(e instanceof Error ? e.message : 'Failed to load jobs')
        setLoadError(true)
      })
      .finally(() => { if (reqId === reqRef.current) setLoading(false) })
  }, [workspace?.id, canManage])

  useEffect(() => { load() }, [load])

  function startCloseout(j: DeliveryJob) {
    setClosing(j.id)
    setForm({
      revenue: j.invoicedRevenueCents != null ? String(j.invoicedRevenueCents / 100) : '',
      other: j.otherCostCents != null ? String(j.otherCostCents / 100) : '',
      onCost: '',
    })
  }

  async function closeout(j: DeliveryJob) {
    if (!workspace) return
    const revenue = parseDollars(form.revenue)
    const other = parseDollars(form.other)
    if (Number.isNaN(revenue) || Number.isNaN(other)) { toast.error('Enter amounts in dollars, or leave blank if unknown'); return }
    const onCost = form.onCost.trim() === '' ? undefined : Number(form.onCost)
    if (onCost !== undefined && (!Number.isFinite(onCost) || onCost < 0 || onCost > 100)) { toast.error('On-cost % must be between 0 and 100'); return }
    setBusy(true)
    try {
      await route('POST /api/delivery/jobs/:id/closeout', {
        params: { id: j.id },
        body: { workspaceId: workspace.id, invoicedRevenueCents: revenue, otherCostCents: other, onCostPct: onCost },
      })
      toast.success(`${j.site.jobCode} closed out`)
      setClosing(null)
      load()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to close out') }
    finally { setBusy(false) }
  }

  async function reopen(j: DeliveryJob) {
    if (!workspace) return
    if (reason.trim().length < 3) { toast.error('Say why the job is being reopened'); return }
    setBusy(true)
    try {
      await route('POST /api/delivery/jobs/:id/reopen', { params: { id: j.id }, body: { workspaceId: workspace.id, reason: reason.trim() } })
      toast.success(`${j.site.jobCode} reopened`)
      setReopening(null); setReason('')
      load()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to reopen') }
    finally { setBusy(false) }
  }

  if (!workspace) return <EmptyState title="No workspace selected" description="Pick a workspace to see its jobs." />

  return (
    <div>
      <OpsSubNav view="ops-delivery" setView={setView} />
      {!canManage ? (
        <EmptyState title="Admins only" description="Quotes, crew rates and margins are visible to workspace admins." />
      ) : loadError ? (
        <ErrorBanner message="Failed to load jobs." onRetry={load} />
      ) : loading && !jobs ? (
        <div style={{ display: 'grid', gap: 12 }}>{[0, 1].map(i => <Skeleton key={i} height={120} />)}</div>
      ) : (
        <div style={{ display: 'grid', gap: 16 }}>
          {report && (
            <Card>
              <div style={{ fontWeight: 600, color: colors.text, marginBottom: 4 }}>What your work actually earns</div>
              <div style={{ fontSize: 12, color: colors.textMuted, marginBottom: 12 }}>
                Closed jobs only. Medians with the number of jobs behind them; a figure needs at least {report.minJobs} jobs.
                Revenue vs quote usually reflects variations the client added, not an estimating miss.
              </div>
              {report.overall.jobs === 0 ? (
                <div style={{ color: colors.textMuted, fontSize: 13 }}>No closed jobs yet. Close out a finished job below to start the picture.</div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ color: colors.textFaint, textAlign: 'left' }}>
                        {['Where the work came from', 'Jobs', 'Hours vs estimate', 'Revenue vs quote', 'Labour margin', 'Gross margin'].map(h => <th key={h} style={{ padding: '6px 8px', fontWeight: 500 }}>{h}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {[report.overall, ...report.groups].map(g => (
                        <tr key={g.key} style={{ borderTop: `1px solid ${colors.border}`, color: colors.text }}>
                          <td style={{ padding: '6px 8px', fontWeight: g.key === 'ALL' ? 600 : 400 }}>{g.label}</td>
                          <td style={{ padding: '6px 8px' }}>{g.jobs}</td>
                          <td style={{ padding: '6px 8px' }}>{statText(g.hoursVariancePct)}</td>
                          <td style={{ padding: '6px 8px' }}>{statText(g.revenueVsQuotePct)}</td>
                          <td style={{ padding: '6px 8px' }}>{statText(g.labourMarginPct)}</td>
                          <td style={{ padding: '6px 8px' }}>{statText(g.grossMarginPct)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          )}

          {(jobs ?? []).length === 0 ? (
            <EmptyState title="No jobs yet" description="Record a quote on work you're pursuing in Find work. When the client accepts, create the job site and it appears here." />
          ) : (jobs ?? []).map(j => {
            const e = j.economics
            return (
              <Card key={j.id}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                  <div>
                    <div style={{ fontWeight: 600, color: colors.text }}>{j.site.jobCode} · {j.site.siteName}</div>
                    {j.origin && <div style={{ fontSize: 12, color: colors.textMuted }}>From: {j.origin.title}</div>}
                  </div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    {e && <Badge color={e.marginBasis === 'GROSS' ? colors.green : e.marginBasis === 'LABOUR' ? colors.amber : colors.textFaint}>{BASIS_LABEL[e.marginBasis]}</Badge>}
                    <Badge color={j.status === 'COMPLETE' ? colors.blue : colors.green}>{j.status === 'COMPLETE' ? `Closed${j.closeoutVersion > 1 ? ` (v${j.closeoutVersion})` : ''}` : 'In progress'}</Badge>
                  </div>
                </div>

                {e && (
                  <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 8 }}>
                    <Figure label="Quoted" value={formatCents(e.quotedCents)} hint={e.estimatedHours != null ? `${e.estimatedHours} h estimated` : undefined} />
                    <Figure label="Hours" value={`${e.actualHours} h`} hint={e.hoursVariancePct != null ? `${formatPct(e.hoursVariancePct)} vs estimate` : e.openShifts ? `${e.openShifts} shift(s) open` : undefined} />
                    <Figure label="Labour cost" value={formatCents(e.labourCostCents)} hint={e.onCostPct ? `incl. ${e.onCostPct}% on-costs` : undefined} />
                    <Figure label="Other costs" value={formatCents(e.otherCostCents)} />
                    <Figure label="Revenue" value={formatCents(e.revenueCents)} hint={e.revenueVsQuotePct != null ? `${formatPct(e.revenueVsQuotePct)} vs quote` : undefined} />
                    <Figure
                      label={e.marginBasis === 'GROSS' ? 'Gross margin' : 'Labour margin'}
                      value={e.marginBasis === 'GROSS' ? formatCents(e.grossMarginCents) : formatCents(e.labourMarginCents)}
                      hint={e.marginBasis === 'GROSS' ? (e.grossMarginPct != null ? `${e.grossMarginPct}%` : undefined) : (e.labourMarginPct != null ? `${e.labourMarginPct}%` : undefined)}
                    />
                  </div>
                )}

                {(j.shiftsAfterCloseout ?? 0) > 0 && (
                  <div role="status" style={{ fontSize: 12, color: colors.amber, marginBottom: 8 }}>
                    {j.shiftsAfterCloseout} shift(s) were logged on this site after closeout and aren't in these figures — reopen the job to include them.
                  </div>
                )}

                {e && e.gaps.length > 0 && (
                  <ul style={{ margin: '0 0 8px', paddingLeft: 18, fontSize: 12, color: colors.textMuted }}>
                    {e.gaps.map(g => <li key={g}>{g}</li>)}
                  </ul>
                )}

                {j.status === 'ACTIVE' && closing !== j.id && <button style={s.btnSm} onClick={() => startCloseout(j)}>Job done — close out</button>}
                {j.status === 'ACTIVE' && closing === j.id && (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                    <div>
                      <label style={s.label} htmlFor={`co-rev-${j.id}`}>Invoiced ($)</label>
                      <input id={`co-rev-${j.id}`} style={{ ...s.input, width: 130 }} inputMode="decimal" value={form.revenue} placeholder="blank = unknown" onChange={ev => setForm(f => ({ ...f, revenue: ev.target.value }))} />
                    </div>
                    <div>
                      <label style={s.label} htmlFor={`co-oth-${j.id}`}>Materials &amp; subcontractors ($)</label>
                      <input id={`co-oth-${j.id}`} style={{ ...s.input, width: 130 }} inputMode="decimal" value={form.other} placeholder="blank = unknown" onChange={ev => setForm(f => ({ ...f, other: ev.target.value }))} />
                    </div>
                    <div>
                      <label style={s.label} htmlFor={`co-onc-${j.id}`}>Labour on-costs (%)</label>
                      <input id={`co-onc-${j.id}`} style={{ ...s.input, width: 90 }} inputMode="decimal" value={form.onCost} placeholder="e.g. 25" onChange={ev => setForm(f => ({ ...f, onCost: ev.target.value }))} />
                    </div>
                    <button style={s.btnSm} disabled={busy} onClick={() => closeout(j)}>Close out</button>
                    <button style={s.btnGhost} disabled={busy} onClick={() => setClosing(null)}>Cancel</button>
                  </div>
                )}
                {j.status === 'COMPLETE' && reopening !== j.id && <button style={s.btnGhost} onClick={() => { setReopening(j.id); setReason('') }}>Reopen</button>}
                {j.status === 'COMPLETE' && reopening === j.id && (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                    <div>
                      <label style={s.label} htmlFor={`ro-${j.id}`}>Why reopen?</label>
                      <input id={`ro-${j.id}`} style={{ ...s.input, width: 260 }} value={reason} placeholder="e.g. late variation invoice" onChange={ev => setReason(ev.target.value)} />
                    </div>
                    <button style={s.btnSm} disabled={busy} onClick={() => reopen(j)}>Reopen job</button>
                    <button style={s.btnGhost} disabled={busy} onClick={() => setReopening(null)}>Cancel</button>
                  </div>
                )}
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
