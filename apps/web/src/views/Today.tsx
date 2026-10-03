import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CommercialOpportunityStatus } from '@acaos/shared'
import type { ApiHook } from '../hooks/useApi.js'
import type { ToastHook } from '../hooks/useToast.js'
import type { View, Workspace } from '../types.js'
import { colors, s } from '../styles.js'
import { makeRouteApi } from '../lib/routeApi.js'
import { formatCents } from '../lib/money.js'
import { Card } from '../components/ui/Card.js'
import { Badge } from '../components/ui/Badge.js'
import { EmptyState } from '../components/ui/EmptyState.js'
import { ErrorBanner } from '../components/ui/ErrorBanner.js'
import { Skeleton } from '../components/ui/Skeleton.js'
import { QuoteCapture, type QuoteSummary } from '../components/ops/QuoteCapture.js'

// The operator console (phase 14): "what should I do today". Commercial
// opportunities that need a decision now, each with the evidence behind it;
// the ones worth watching; what's newly detected; and what ACAOS has produced —
// pipeline, won revenue and (admins) delivered margin. Every number shows what
// it rests on; nothing here sends anything.

type Props = { api: ApiHook; workspace: Workspace | null; toast: ToastHook; isAdmin?: boolean; setView: (v: View) => void }

type Opp = {
  id: string; eventType: string; eventTitle: string; whyNow: string
  confidence: number; independentSources: number; expectedValueCents: number | null
  estimatedValueMinCents: number | null; estimatedValueMaxCents: number | null; probability: number
  urgency: 'HIGH' | 'MEDIUM' | 'LOW'; priority: number; buyingStage: string
  actionLabel: string; actionReason: string; recommendationKind: string | null; intelligenceGate: boolean
  status: CommercialOpportunityStatus; firstDetectedAt: string
  prospect: { id: string; companyName: string; domain: string | null }
  offer: { id: string; name: string } | null
}

type Citation = { claim: string; source: string; sourceUrl: string | null; eventDate: string; ageDays: number; quality: number }
type Detail = {
  opportunity: Opp & {
    reasons: string[]; blockers: string[]
    recommendation: null | { label: string; headline: string; why: string[]; citations: Citation[]; outreach: boolean; nextSteps: string[] }
    prospect: Opp['prospect'] & { contactName: string | null; contactTitle: string | null; contactEmail: string | null }
  }
}

type Summary = {
  opportunities: number
  reached: Record<string, number>
  conversion: { quotedToWon: number | null; sentToReplied: number | null }
  wonRevenueCents: { sourced: number; influenced: number }
}

type ReportStat = { n: number; median: number } | null
type DeliveryReport = { minJobs: number; overall: { jobs: number; grossMarginPct: ReportStat; labourMarginPct: ReportStat } }

const DAY = 86_400_000
const NEW_WINDOW_DAYS = 7

const pct = (x: number | null | undefined) => (x == null ? '—' : `${Math.round(x * 100)}%`)
const humanize = (k: string) => k.toLowerCase().replace(/_/g, ' ')

function valueText(o: Opp): string {
  if (o.expectedValueCents != null) return `${formatCents(o.expectedValueCents)} expected`
  if (o.estimatedValueMinCents != null && o.estimatedValueMaxCents != null) return `${formatCents(o.estimatedValueMinCents)}–${formatCents(o.estimatedValueMaxCents)}`
  return 'value unknown'
}

// Act now: open work the engine rates HIGH urgency, plus everything already being pursued.
export function needsAttention(o: Opp): boolean {
  return o.status === 'PURSUING' || (o.status === 'OPEN' && o.urgency === 'HIGH')
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card style={{ flex: '1 1 160px' }}>
      <div style={{ fontSize: 11, color: colors.textFaint, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: colors.text, margin: '4px 0' }}>{value}</div>
      {hint && <div style={{ fontSize: 12, color: colors.textMuted }}>{hint}</div>}
    </Card>
  )
}

export function Today({ api, workspace, toast, isAdmin = false, setView }: Props) {
  const route = useMemo(() => makeRouteApi(api), [api])
  const [opps, setOpps] = useState<Opp[] | null>(null)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [delivery, setDelivery] = useState<DeliveryReport | null>(null)
  const [quotes, setQuotes] = useState<Map<string, QuoteSummary>>(new Map())
  const [network, setNetwork] = useState<'in' | 'out' | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const [detail, setDetail] = useState<Detail['opportunity'] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const reqRef = useRef(0)
  const load = useCallback(() => {
    if (!workspace) return
    const reqId = ++reqRef.current
    const ws = workspace.id
    setLoading(true)
    setLoadError(false)
    // The two core reads must succeed; admin extras degrade to "not shown".
    Promise.all([
      api<{ opportunities: Opp[] }>(`/api/commercial-opportunities?workspaceId=${ws}&limit=100`),
      api<{ summary: Summary }>(`/api/commercial-opportunities/outcomes?workspaceId=${ws}`),
      isAdmin ? api<{ report: DeliveryReport }>(`/api/delivery/report?workspaceId=${ws}`).catch(() => null) : Promise.resolve(null),
      isAdmin ? api<{ quotes: QuoteSummary[] }>(`/api/delivery/quotes?workspaceId=${ws}`).catch(() => ({ quotes: [] as QuoteSummary[] })) : Promise.resolve({ quotes: [] as QuoteSummary[] }),
      // 403 means "not opted in" — the benchmarks are only for contributors.
      isAdmin ? api(`/api/commercial-opportunities/network-benchmarks?workspaceId=${ws}`).then(() => 'in' as const, () => 'out' as const) : Promise.resolve(null),
    ])
      .then(([list, outcomes, report, quoteList, net]) => {
        if (reqId !== reqRef.current) return
        setOpps(list.opportunities)
        setSummary(outcomes.summary)
        setDelivery(report?.report ?? null)
        const latest = new Map<string, QuoteSummary>()
        for (const q of quoteList.quotes ?? []) {
          const key = q.commercialOpportunityId
          if (key && !latest.has(key) && q.status !== 'WITHDRAWN' && q.status !== 'REJECTED') latest.set(key, q)
        }
        setQuotes(latest)
        setNetwork(net)
      })
      .catch(e => {
        if (reqId !== reqRef.current) return
        toast.error(e instanceof Error ? e.message : 'Failed to load today')
        setLoadError(true)
      })
      .finally(() => { if (reqId === reqRef.current) setLoading(false) })
  }, [workspace?.id, isAdmin])

  useEffect(() => { load() }, [load])

  async function toggle(o: Opp) {
    if (open === o.id) { setOpen(null); return }
    setOpen(o.id)
    setDetail(null)
    try {
      const r = await api<Detail>(`/api/commercial-opportunities/${o.id}?workspaceId=${workspace!.id}`)
      setDetail(r.opportunity)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to load the evidence') }
  }

  async function setStatus(o: Opp, status: Exclude<CommercialOpportunityStatus, 'EXPIRED'>) {
    if (!workspace) return
    setBusyId(o.id)
    try {
      await route('PATCH /api/commercial-opportunities/:id/status', { params: { id: o.id }, body: { workspaceId: workspace.id, status } })
      load()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to update') }
    finally { setBusyId(null) }
  }

  async function proposeOutreach(o: Opp) {
    if (!workspace) return
    setBusyId(o.id)
    try {
      const r = await route('POST /api/commercial-opportunities/:id/intent', { params: { id: o.id }, body: { workspaceId: workspace.id } })
      toast.success(r.created ? 'Outreach proposed — draft and approve it in To Review' : 'Outreach was already proposed — see To Review')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to propose outreach') }
    finally { setBusyId(null) }
  }

  async function setParticipation(optIn: boolean) {
    if (!workspace) return
    try {
      await route('PUT /api/commercial-opportunities/network-participation', { body: { workspaceId: workspace.id, optIn } })
      setNetwork(optIn ? 'in' : 'out')
      toast.success(optIn ? 'Sharing anonymised win rates — benchmarks appear once enough workspaces contribute' : 'Stopped sharing')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to update sharing') }
  }

  if (!workspace) return <EmptyState title="No workspace selected" description="Pick a workspace to see today's work." />
  if (loadError) return <ErrorBanner message="Failed to load today." onRetry={load} />
  if (loading && !opps) return <div style={{ display: 'grid', gap: 12 }}>{[0, 1, 2].map(i => <Skeleton key={i} height={110} />)}</div>

  const all = opps ?? []
  const now = Date.now()
  const act = all.filter(needsAttention)
  const watch = all.filter(o => o.status === 'OPEN' && !needsAttention(o))
  const fresh = all.filter(o => now - Date.parse(o.firstDetectedAt) <= NEW_WINDOW_DAYS * DAY)
  const pipelineCents = all.filter(o => o.status === 'OPEN' || o.status === 'PURSUING').reduce((t, o) => t + (o.expectedValueCents ?? 0), 0)
  const won = summary ? summary.wonRevenueCents.sourced + summary.wonRevenueCents.influenced : 0
  const margin = delivery?.overall.grossMarginPct ?? delivery?.overall.labourMarginPct ?? null
  const marginKind = delivery?.overall.grossMarginPct ? 'gross' : 'labour'

  const renderOpp = (o: Opp) => (
    <Card key={o.id}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, color: colors.text }}>{o.prospect.companyName} — {o.eventTitle}</div>
          <div style={{ fontSize: 13, color: colors.textMuted, marginTop: 2 }}>{o.whyNow}</div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          {o.status === 'PURSUING' && <Badge color={colors.blue}>Pursuing</Badge>}
          {o.urgency === 'HIGH' && <Badge color={colors.red}>Urgent</Badge>}
          {!o.intelligenceGate && <Badge color={colors.amber}>Unconfirmed</Badge>}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, color: colors.textMuted, margin: '8px 0' }}>
        <span>{valueText(o)}</span>
        <span>{pct(o.probability)} chance</span>
        <span>{o.confidence}% confident · {o.independentSources} source{o.independentSources === 1 ? '' : 's'}</span>
        <span>{humanize(o.buyingStage)}</span>
        {o.offer && <span>Offer: {o.offer.name}</span>}
      </div>
      <div style={{ fontSize: 13, color: colors.blueLight }}>
        <span style={{ color: colors.textFaint }}>Next: </span>{o.actionLabel}
        <span style={{ color: colors.textMuted }}> — {o.actionReason}</span>
      </div>

      {open === o.id && (
        <div style={{ marginTop: 10, borderTop: `1px solid ${colors.border}`, paddingTop: 10, fontSize: 13 }}>
          {!detail ? <Skeleton height={60} /> : (
            <>
              {detail.recommendation && (
                <div style={{ marginBottom: 8 }}>
                  <div style={{ color: colors.text, fontWeight: 600 }}>{detail.recommendation.headline}</div>
                  <ul style={{ margin: '4px 0', paddingLeft: 18, color: colors.textMuted }}>
                    {detail.recommendation.why.map(w => <li key={w}>{w}</li>)}
                  </ul>
                </div>
              )}
              <div style={{ color: colors.textFaint, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>Evidence</div>
              <ul style={{ margin: '4px 0 8px', paddingLeft: 18, color: colors.textMuted }}>
                {(detail.recommendation?.citations ?? []).map(c => (
                  <li key={`${c.source}-${c.claim}`}>
                    {c.claim} <span style={{ color: colors.textFaint }}>· {c.source}, {c.ageDays}d ago</span>
                    {c.sourceUrl && <> · <a href={c.sourceUrl} target="_blank" rel="noopener noreferrer" style={{ color: colors.blueLight }}>source ↗</a></>}
                  </li>
                ))}
                {(detail.recommendation?.citations ?? []).length === 0 && <li>No citable evidence — treat this as a lead to check, not a fact.</li>}
              </ul>
              {detail.blockers.length > 0 && <div style={{ color: colors.amber, marginBottom: 8 }}>Blocked by: {detail.blockers.join('; ')}</div>}
              {(detail.prospect.contactName || detail.prospect.contactEmail) && (
                <div style={{ color: colors.textMuted, marginBottom: 8 }}>
                  Contact: {detail.prospect.contactName ?? '—'}{detail.prospect.contactTitle ? `, ${detail.prospect.contactTitle}` : ''}
                  {detail.prospect.contactEmail && <> · <a href={`mailto:${detail.prospect.contactEmail}`} style={{ color: colors.blueLight }}>{detail.prospect.contactEmail}</a></>}
                </div>
              )}
              {isAdmin && detail.recommendation?.outreach && (
                <button style={s.btnSm} disabled={busyId === o.id} onClick={() => proposeOutreach(o)}>Propose outreach</button>
              )}
            </>
          )}
        </div>
      )}

      {isAdmin && (o.status === 'PURSUING' || quotes.has(o.id)) && (
        <div style={{ marginTop: 8 }}>
          <QuoteCapture route={route} toast={toast} workspaceId={workspace.id} target={{ commercialOpportunityId: o.id }} quote={quotes.get(o.id) ?? null} onChanged={load} />
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
        <button style={s.btnGhost} onClick={() => toggle(o)}>{open === o.id ? 'Hide evidence' : 'Why? Show evidence'}</button>
        {o.status === 'OPEN' && <button style={s.btnSm} disabled={busyId === o.id} onClick={() => setStatus(o, 'PURSUING')}>Pursue</button>}
        {o.status === 'PURSUING' && <button style={s.btnGhost} disabled={busyId === o.id} onClick={() => setStatus(o, 'LOST')}>Lost it</button>}
        {(o.status === 'OPEN' || o.status === 'PURSUING') && <button style={s.btnGhost} disabled={busyId === o.id} onClick={() => setStatus(o, 'DISMISSED')}>Not for us</button>}
      </div>
    </Card>
  )

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 22, color: colors.text }}>Today</h1>
        <div style={{ color: colors.textMuted, fontSize: 13 }}>What needs a decision, why, and what it's worth. Nothing here sends anything.</div>
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <Kpi label="Open pipeline" value={formatCents(pipelineCents)} hint={`${all.filter(o => o.status === 'OPEN' || o.status === 'PURSUING').length} opportunities, value × chance`} />
        <Kpi label="Won through ACAOS" value={formatCents(won)} hint={summary ? `${formatCents(summary.wonRevenueCents.sourced)} sourced · ${formatCents(summary.wonRevenueCents.influenced)} influenced` : undefined} />
        <Kpi label="Quote → win" value={pct(summary?.conversion.quotedToWon)} hint={summary ? `${summary.reached.QUOTED ?? 0} quoted` : undefined} />
        {isAdmin && (
          <Kpi
            label="Delivered margin"
            value={margin ? `${margin.median}%` : '—'}
            hint={margin ? `median ${marginKind}, ${margin.n} closed jobs` : `needs ${delivery?.minJobs ?? 3}+ closed jobs`}
          />
        )}
      </div>

      <section>
        <h2 style={{ fontSize: 15, color: colors.text, margin: '0 0 8px' }}>Needs your decision ({act.length})</h2>
        {act.length === 0
          ? <EmptyState title="Nothing urgent" description="No high-urgency opportunities right now. ACAOS keeps watching the signals." />
          : <div style={{ display: 'grid', gap: 10 }}>{act.map(renderOpp)}</div>}
      </section>

      {fresh.length > 0 && (
        <section>
          <h2 style={{ fontSize: 15, color: colors.text, margin: '0 0 8px' }}>New this week ({fresh.length})</h2>
          <div style={{ display: 'grid', gap: 6 }}>
            {fresh.map(o => (
              <div key={o.id} style={{ fontSize: 13, color: colors.textMuted }}>
                <strong style={{ color: colors.text }}>{o.prospect.companyName}</strong> — {o.eventTitle} <span style={{ color: colors.textFaint }}>· {humanize(o.eventType)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 style={{ fontSize: 15, color: colors.text, margin: '0 0 8px' }}>Worth watching ({watch.length})</h2>
        {watch.length === 0
          ? <div style={{ fontSize: 13, color: colors.textMuted }}>Nothing to monitor yet. <button style={s.btnGhost} onClick={() => setView('prospects')}>Add potential clients</button></div>
          : <div style={{ display: 'grid', gap: 10 }}>{watch.slice(0, 10).map(renderOpp)}</div>}
      </section>

      {isAdmin && network && (
        <Card>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ fontSize: 13, color: colors.textMuted, maxWidth: 560 }}>
              <strong style={{ color: colors.text }}>Cross-customer benchmarks</strong> — share anonymised win counts per signal type (never names, prices or evidence) and see how others convert. Published only once 5+ workspaces contribute.
            </div>
            {network === 'in'
              ? <button style={s.btnGhost} onClick={() => setParticipation(false)}>Stop sharing</button>
              : <button style={s.btnSm} onClick={() => setParticipation(true)}>Opt in</button>}
          </div>
        </Card>
      )}
    </div>
  )
}
