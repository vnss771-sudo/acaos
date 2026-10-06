import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiHook } from '../../hooks/useApi.js'
import type { ToastHook } from '../../hooks/useToast.js'
import type { View, Workspace } from '../../types.js'
import { colors, s } from '../../styles.js'
import { formatCents } from '../../lib/money.js'
import { insightText, marginText, plural, ratePct, thisWeekItems, windowText, type PilotScorecard } from '../../lib/scorecard.js'
import { Card } from '../../components/ui/Card.js'
import { Badge } from '../../components/ui/Badge.js'
import { EmptyState } from '../../components/ui/EmptyState.js'
import { ErrorBanner } from '../../components/ui/ErrorBanner.js'
import { Skeleton } from '../../components/ui/Skeleton.js'
import { OpsSubNav } from '../../components/ops/OpsSubNav.js'

// The pilot scorecard: is ACAOS helping this business find and win worthwhile
// work? This week against the pilot targets, the weeks behind it, and which
// source makes the money. Admin-only, like Jobs & margins: quotes and margins.

type Props = { api: ApiHook; workspace: Workspace | null; toast: ToastHook; canManage?: boolean; setView: (v: View) => void }

const weekLabel = (iso: string) => new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })

function Target({ met }: { met: boolean | null }) {
  if (met == null) return <Badge color={colors.textFaint}>Not yet</Badge>
  return met ? <Badge color={colors.green}>On target</Badge> : <Badge color={colors.amber}>Below target</Badge>
}

const th: React.CSSProperties = { padding: '6px 8px', fontWeight: 500 }
const td: React.CSSProperties = { padding: '6px 8px' }

export function OpsScorecard({ api, workspace, toast, canManage = false, setView }: Props) {
  const [scorecard, setScorecard] = useState<PilotScorecard | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)

  const reqRef = useRef(0)
  const load = useCallback(() => {
    if (!workspace || !canManage) return
    const reqId = ++reqRef.current
    setLoading(true)
    setLoadError(false)
    api<{ scorecard?: PilotScorecard }>(`/api/delivery/scorecard?workspaceId=${workspace.id}`)
      .then(r => { if (reqId === reqRef.current) setScorecard(r.scorecard ?? null) })
      .catch(e => {
        if (reqId !== reqRef.current) return
        toast.error(e instanceof Error ? e.message : 'Failed to load the scorecard')
        setLoadError(true)
      })
      .finally(() => { if (reqId === reqRef.current) setLoading(false) })
  }, [workspace?.id, canManage])

  useEffect(() => { load() }, [load])

  if (!workspace) return <EmptyState title="No workspace selected" description="Pick a workspace to see its scorecard." />

  return (
    <div>
      <OpsSubNav view="ops-scorecard" setView={setView} />
      {!canManage ? (
        <EmptyState title="Admins only" description="Quotes, wins and margins are visible to workspace admins." />
      ) : loadError ? (
        <ErrorBanner message="Failed to load the scorecard." onRetry={load} />
      ) : loading && !scorecard ? (
        <div style={{ display: 'grid', gap: 12 }}>{[0, 1].map(i => <Skeleton key={i} height={120} />)}</div>
      ) : !scorecard ? (
        <EmptyState title="No scorecard yet" description="Set up Find work and the scorecard fills in as work is found, quoted and won." />
      ) : (
        <ScorecardBody sc={scorecard} setView={setView} />
      )}
    </div>
  )
}

function ScorecardBody({ sc, setView }: { sc: PilotScorecard; setView: (v: View) => void }) {
  const week = sc.weeks[0]
  const insight = insightText(sc)
  const c = sc.closeout
  const q = sc.conversion.quoteToWon
  const d = sc.conversion.discoveryToQuote
  const met = sc.checks.weeksMet
  const closeoutDetail = [
    c.inProgress > 0 ? `${c.inProgress} in progress` : null,
    c.notStarted > 0 ? `${c.notStarted} not started` : null,
    c.closedWithoutInvoice > 0 ? `${c.closedWithoutInvoice} closed without an invoice` : null,
  ].filter(Boolean).join(' · ')

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <Card>
        <div style={{ fontWeight: 600, color: colors.text, marginBottom: 4 }}>This week</div>
        <div style={{ fontSize: 12, color: colors.textMuted, marginBottom: 10 }}>The last 7 days of Find work.</div>
        <div style={{ fontSize: 15, color: colors.text }}>{thisWeekItems(sc).join(' · ')}</div>
        {week.wonWithoutAmount > 0 && (
          <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 4 }}>
            {plural(week.wonWithoutAmount, 'win')} without an accepted quote, so the amount is unknown.
          </div>
        )}
        <div style={{ fontSize: 13, color: colors.textMuted, marginTop: 8 }}>
          {marginText(sc)}{sc.bestSource ? ` · Best source: ${sc.bestSource.label}` : ''}
        </div>
        {insight && <div style={{ fontSize: 13, color: colors.text, marginTop: 10 }}>{insight}</div>}
      </Card>

      <Card>
        <div style={{ fontWeight: 600, color: colors.text, marginBottom: 4 }}>Pilot targets</div>
        <div style={{ fontSize: 12, color: colors.textMuted, marginBottom: 12 }}>Weeks on target count full weeks only.</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ color: colors.textFaint, textAlign: 'left' }}>
                {['Target', 'Now', 'Weeks on target', ''].map(h => <th key={h} style={th}>{h}</th>)}
              </tr>
            </thead>
            <tbody style={{ color: colors.text }}>
              <tr style={{ borderTop: `1px solid ${colors.border}` }}>
                <td style={td}>Work found: {sc.targets.foundPerWeek}+ a week</td>
                <td style={td}>{week.found} this week</td>
                <td style={td}>{met.of > 0 ? `${met.found} of ${met.of}` : '—'}</td>
                <td style={td}><Target met={sc.checks.thisWeek.found} /></td>
              </tr>
              <tr style={{ borderTop: `1px solid ${colors.border}` }}>
                <td style={td}>Quotes from Find work: {sc.targets.quotesPerWeek}+ a week</td>
                <td style={td}>{week.quoted} this week</td>
                <td style={td}>{met.of > 0 ? `${met.quotes} of ${met.of}` : '—'}</td>
                <td style={td}><Target met={sc.checks.thisWeek.quotes} /></td>
              </tr>
              <tr style={{ borderTop: `1px solid ${colors.border}` }}>
                <td style={td}>Won jobs closed out with an invoice: {ratePct(sc.targets.closeoutRate)}</td>
                <td style={td}>
                  {c.won - c.cancelled > 0 ? `${c.closedOut} of ${c.won - c.cancelled} (${ratePct(c.rate)})` : 'No wins yet'}
                  {closeoutDetail && <div style={{ fontSize: 11, color: colors.textMuted }}>{closeoutDetail}</div>}
                </td>
                <td style={td}>—</td>
                <td style={td}><Target met={sc.checks.closeout} /></td>
              </tr>
              <tr style={{ borderTop: `1px solid ${colors.border}` }}>
                <td style={td}>Most profitable source known</td>
                <td style={td}>
                  {sc.checks.sourceIdentified && sc.bestSource
                    ? `${sc.bestSource.label} (${formatCents(sc.bestSource.cents)} gross margin)`
                    : 'Needs a closed-out job with its costs entered'}
                </td>
                <td style={td}>—</td>
                <td style={td}><Target met={sc.checks.sourceIdentified ? true : null} /></td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <div style={{ fontWeight: 600, color: colors.text, marginBottom: 4 }}>Totals {windowText(sc)}</div>
        <div style={{ fontSize: 13, color: colors.text, display: 'grid', gap: 4 }}>
          <div>{sc.totals.found} found · {sc.totals.pursued} worth pursuing · {plural(sc.totals.quoted, 'quote')} ({formatCents(sc.totals.quotedCents)}) · {sc.totals.won} won ({formatCents(sc.totals.wonCents)})</div>
          <div style={{ color: colors.textMuted }}>
            Found → quoted: {ratePct(d.rate)} ({d.quoted} of {d.found}) · Quote → won: {ratePct(q.rate)} ({q.won} of {q.won + q.lost} decided{q.awaiting > 0 ? `, ${q.awaiting} awaiting a decision` : ''})
          </div>
          <div style={{ color: colors.textMuted }}>{marginText(sc)}</div>
        </div>
      </Card>

      {sc.sources.length > 0 && (
        <Card>
          <div style={{ fontWeight: 600, color: colors.text, marginBottom: 12 }}>By source</div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ color: colors.textFaint, textAlign: 'left' }}>
                  {['Source', 'Found', 'Quoted', 'Won', 'Won value', 'Closed jobs', 'Gross margin'].map(h => <th key={h} style={th}>{h}</th>)}
                </tr>
              </thead>
              <tbody style={{ color: colors.text }}>
                {sc.sources.map(src => (
                  <tr key={src.kind} style={{ borderTop: `1px solid ${colors.border}` }}>
                    <td style={td}>{src.label}</td>
                    <td style={td}>{src.found}</td>
                    <td style={td}>{src.quoted}</td>
                    <td style={td}>{src.won}</td>
                    <td style={td}>{formatCents(src.wonCents)}</td>
                    <td style={td}>{src.closedJobs}</td>
                    <td style={td}>{src.grossMarginCents == null ? '—' : `${formatCents(src.grossMarginCents)} (${src.grossMarginPct}%)`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card>
        <div style={{ fontWeight: 600, color: colors.text, marginBottom: 12 }}>Week by week</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ color: colors.textFaint, textAlign: 'left' }}>
                {['Week to', 'Found', 'Worth pursuing', 'Quoted', 'Quoted value', 'Won', 'Won value'].map(h => <th key={h} style={th}>{h}</th>)}
              </tr>
            </thead>
            <tbody style={{ color: colors.text }}>
              {sc.weeks.map(w => (
                <tr key={w.end} style={{ borderTop: `1px solid ${colors.border}` }}>
                  <td style={td}>{weekLabel(w.end)}{w.partial ? ' (part week)' : ''}</td>
                  <td style={td}>{w.found}</td>
                  <td style={td}>{w.pursued}</td>
                  <td style={td}>{w.quoted}</td>
                  <td style={td}>{formatCents(w.quotedCents)}</td>
                  <td style={td}>{w.won}</td>
                  <td style={td}>{formatCents(w.wonCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button style={s.btnGhost} onClick={() => setView('ops-find-work')}>Open Find work</button>
          <button style={s.btnGhost} onClick={() => setView('ops-delivery')}>Open Jobs & margins</button>
        </div>
      </Card>
    </div>
  )
}
