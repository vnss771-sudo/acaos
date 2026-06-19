import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import type { UpdateMissionRequest, DiscoverProspectsRequest } from '@acaos/shared'
import type { Mission, MissionDetail, MissionStatus, Workspace } from '../types.js'
import { s, colors } from '../styles.js'
import { Spinner, EmptyState } from '../components/Spinner.js'
import { MissionBuilder } from '../components/MissionBuilder.js'
import { makeRouteApi } from '../lib/routeApi.js'
import type { ApiHook } from '../hooks/useApi.js'
import type { ToastHook } from '../hooks/useToast.js'

type Props = { api: ApiHook; workspace: Workspace | null; toast: ToastHook; canManage?: boolean }

const STATUS_COLOR: Record<MissionStatus, string> = {
  DRAFT: colors.textFaint,
  DISCOVERING: colors.blue,
  REVIEWING: colors.blue,
  ACTIVE: colors.green,
  PAUSED: colors.amber,
  COMPLETE: colors.textMuted,
}

function StatusBadge({ status }: { status: MissionStatus }) {
  return (
    <span style={{
      fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', padding: '2px 8px',
      borderRadius: 99, color: STATUS_COLOR[status], border: `1px solid ${STATUS_COLOR[status]}55`,
    }}>
      {status}
    </span>
  )
}

export function MissionsView({ api, workspace, toast, canManage = false }: Props) {
  const route = useMemo(() => makeRouteApi(api), [api])
  const [missions, setMissions] = useState<Mission[]>([])
  const [loading, setLoading] = useState(true)
  const [showBuilder, setShowBuilder] = useState(false)
  const [busy, setBusy] = useState<Record<string, boolean>>({})

  // Monotonic request id so only the latest load applies (load runs from the
  // effect on workspace change and imperatively after status edits).
  const loadReqRef = useRef(0)
  const load = useCallback(() => {
    if (!workspace) return
    const reqId = ++loadReqRef.current
    setLoading(true)
    api<{ missions: Mission[] }>(`/api/missions?workspaceId=${workspace.id}`)
      .then(d => { if (reqId === loadReqRef.current) setMissions(d.missions || []) })
      .catch(e => { if (reqId === loadReqRef.current) toast.error(e instanceof Error ? e.message : 'Failed to load missions') })
      .finally(() => { if (reqId === loadReqRef.current) setLoading(false) })
  }, [api, workspace?.id, toast])

  useEffect(() => { load() }, [workspace?.id])

  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  async function setStatus(id: string, status: MissionStatus) {
    setBusy(prev => ({ ...prev, [id]: true }))
    try {
      const body: UpdateMissionRequest = { status }
      const d = await route('PATCH /api/missions/:id', { params: { id }, body }) as { mission: Mission }
      setMissions(prev => prev.map(m => m.id === id ? d.mission : m))
      toast.success(`Mission ${status.toLowerCase()}`)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Update failed') }
    finally { setBusy(prev => ({ ...prev, [id]: false })) }
  }

  async function discover(id: string) {
    if (!workspace) return
    setBusy(prev => ({ ...prev, [id]: true }))
    try {
      const body: DiscoverProspectsRequest = { workspaceId: workspace.id, missionId: id }
      const d = await route('POST /api/prospects/discover', { body })
      toast.success(`Discovered ${d.discovered} new prospect${d.discovered !== 1 ? 's' : ''} (${d.skipped} skipped)`)
      load()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Discovery failed') }
    finally { setBusy(prev => ({ ...prev, [id]: false })) }
  }

  if (!workspace) return null
  if (loading) return <Spinner />

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <p style={{ color: colors.textMuted, fontSize: 13, margin: 0 }}>
          A mission ties your target, offer, and outreach into one tracked workflow.
        </p>
        {canManage && <button style={s.btn} onClick={() => setShowBuilder(true)}>+ New Mission</button>}
      </div>

      {missions.length === 0 ? (
        <EmptyState message="No missions yet — launch your first mission to start acquiring customers." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {missions.map(m => {
            const leads = m.campaign?._count?.leads ?? 0
            const isBusy = busy[m.id]
            return (
              <div key={m.id} style={{ ...s.card, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ color: colors.text, fontWeight: 700, fontSize: 15 }}>{m.name}</span>
                    <StatusBadge status={m.status} />
                  </div>
                  <span style={{ color: colors.textMuted, fontSize: 12 }}>{m.goalType.replace(/_/g, ' ')}</span>
                </div>
                {m.targetCustomer && (
                  <div style={{ color: colors.textMuted, fontSize: 13 }}>
                    <strong style={{ color: colors.textFaint }}>Target:</strong> {m.targetCustomer}
                  </div>
                )}
                {m.offer && (
                  <div style={{ color: colors.textMuted, fontSize: 13 }}>
                    <strong style={{ color: colors.textFaint }}>Offer:</strong> {m.offer}
                  </div>
                )}
                {m.stats && (m.stats.sent > 0 || m.stats.failed > 0) && (
                  <div style={{ display: 'flex', gap: 14, fontSize: 12, color: colors.textMuted }}>
                    <span>{m.stats.sent} sent</span>
                    <span style={{ color: colors.green }}>{m.stats.replied} replied</span>
                    {(m.stats.failed + m.stats.bounced) > 0 && (
                      <span style={{ color: colors.red }}>{m.stats.failed + m.stats.bounced} failed/bounced</span>
                    )}
                  </div>
                )}
                {(m.stats?.pendingDrafts ?? 0) > 0 && (
                  <div style={{ fontSize: 12, color: colors.amber }}>
                    ✎ {m.stats!.pendingDrafts} draft{m.stats!.pendingDrafts !== 1 ? 's' : ''} awaiting review
                  </div>
                )}
                {(m.discovery?.runs ?? 0) > 0 && (
                  <div style={{ fontSize: 12, color: colors.textMuted }}>
                    🔍 {m.discovery!.discovered} prospect{m.discovery!.discovered !== 1 ? 's' : ''} discovered
                    {' '}across {m.discovery!.runs} run{m.discovery!.runs !== 1 ? 's' : ''}
                  </div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
                  <span style={{ color: colors.textFaint, fontSize: 12 }}>{leads} lead{leads !== 1 ? 's' : ''} enrolled</span>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      style={{ ...s.btnSm, border: `1px solid ${colors.border}` }}
                      disabled={isBusy}
                      onClick={() => setExpanded(prev => ({ ...prev, [m.id]: !prev[m.id] }))}
                    >
                      {expanded[m.id] ? 'Hide details' : 'Details'}
                    </button>
                    {canManage && (
                      <button style={s.btnSm} disabled={isBusy} onClick={() => discover(m.id)}>
                        {isBusy ? 'Discovering…' : 'Discover prospects'}
                      </button>
                    )}
                    {canManage && (m.status === 'PAUSED' || m.status === 'DRAFT' ? (
                      <button style={s.btnSm} disabled={isBusy} onClick={() => setStatus(m.id, 'ACTIVE')}>Activate</button>
                    ) : m.status !== 'COMPLETE' ? (
                      <button style={s.btnSm} disabled={isBusy} onClick={() => setStatus(m.id, 'PAUSED')}>Pause</button>
                    ) : null)}
                    {canManage && m.status !== 'COMPLETE' && (
                      <button style={{ ...s.btnSm, border: `1px solid ${colors.border}` }} disabled={isBusy} onClick={() => setStatus(m.id, 'COMPLETE')}>
                        Complete
                      </button>
                    )}
                  </div>
                </div>
                {expanded[m.id] && <MissionDetailPanel api={api} missionId={m.id} toast={toast} canManage={canManage} />}
              </div>
            )
          })}
        </div>
      )}

      {showBuilder && workspace && (
        <MissionBuilder
          workspace={workspace}
          api={api}
          toast={toast}
          onCreated={() => { setShowBuilder(false); toast.success('Mission launched'); load() }}
          onClose={() => setShowBuilder(false)}
        />
      )}
    </div>
  )
}

// Guided walkthrough overlay for the mission loop. Purely orientational: each
// step's done/current state is derived from the same funnel/readiness/engagement
// data the hub already loads, and the "Next" line points at the control already
// on screen — so it guides a new operator without hiding or duplicating anything.
function MissionGuide({ detail }: { detail: MissionDetail }) {
  const steps = [
    { label: 'Discover', done: detail.funnel.discovered > 0, hint: 'Use “Discover prospects” to find companies that match your ICP.' },
    { label: 'Score & recommend', done: detail.funnel.recommended > 0, hint: 'Hit “Score & recommend” to turn prospects into outreach recommendations.' },
    { label: 'Review & approve', done: detail.funnel.approved > 0, hint: 'Generate a draft for each recommendation in the action queue, then approve the keepers.' },
    { label: 'Ready to send', done: detail.sendReadiness.ready, hint: 'Clear the send-readiness checks below (SMTP + compliance details).' },
    { label: 'Engaged', done: detail.engagement.sent > 0, hint: 'Run the campaign — replies and learning appear under Engagement.' },
  ]
  const currentIdx = steps.findIndex(s => !s.done)
  const current = currentIdx === -1 ? null : steps[currentIdx]

  return (
    <div style={{ border: `1px solid ${colors.border}`, borderRadius: 8, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
        {steps.map((st, i) => {
          const isCurrent = i === currentIdx
          const color = st.done ? colors.green : isCurrent ? colors.blue : colors.textFaint
          return (
            <React.Fragment key={st.label}>
              {i > 0 && <span aria-hidden style={{ color: colors.border, fontSize: 12 }}>›</span>}
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color, fontWeight: isCurrent ? 700 : 500 }}>
                <span style={{
                  width: 16, height: 16, borderRadius: 99, border: `1.5px solid ${color}`,
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700,
                }}>{st.done ? '✓' : i + 1}</span>
                {st.label}
              </span>
            </React.Fragment>
          )
        })}
      </div>
      {current ? (
        <div style={{ color: colors.textMuted, fontSize: 12 }}>
          <strong style={{ color: colors.text }}>Next:</strong> {current.hint}
        </div>
      ) : (
        <div style={{ color: colors.green, fontSize: 12 }}>✓ Full loop complete — this mission is discovering, sending, and learning.</div>
      )}
    </div>
  )
}

// The mission control plane: playbook, discovery history, owned prospects, and
// the actionable outreach queue scoped to this mission. Lazy-loaded on expand.
function MissionDetailPanel({ api, missionId, toast, canManage }: { api: ApiHook; missionId: string; toast: ToastHook; canManage: boolean }) {
  const route = useMemo(() => makeRouteApi(api), [api])
  const [detail, setDetail] = useState<MissionDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<Record<string, boolean>>({})

  const reqRef = useRef(0)
  const load = useCallback(() => {
    const reqId = ++reqRef.current
    setLoading(true)
    api<MissionDetail>(`/api/missions/${missionId}`)
      .then(d => { if (reqId === reqRef.current) setDetail(d) })
      .catch(e => { if (reqId === reqRef.current) toast.error(e instanceof Error ? e.message : 'Failed to load mission detail') })
      .finally(() => { if (reqId === reqRef.current) setLoading(false) })
  }, [api, missionId, toast])

  useEffect(() => { load() }, [missionId])

  // Run an action, then refresh the funnel + queue so the operator sees the
  // result of each step without leaving the mission.
  const act = useCallback(async (key: string, fn: () => Promise<unknown>, successMsg: string) => {
    setBusy(prev => ({ ...prev, [key]: true }))
    try { await fn(); toast.success(successMsg); load() }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Action failed') }
    finally { setBusy(prev => ({ ...prev, [key]: false })) }
  }, [load, toast])

  const score = () => act('score',
    () => route('POST /api/missions/:id/score', { params: { id: missionId } }),
    'Scoring started — recommendations will appear shortly')

  const intentAction = (prospectId: string, intentId: string, verb: 'draft' | 'approve' | 'reject', msg: string) =>
    act(`${verb}:${intentId}`,
      () => route('POST /api/prospects/:prospectId/intents/:intentId/:action', { params: { prospectId, intentId, action: verb } }),
      msg)

  const panel: React.CSSProperties = { borderTop: `1px solid ${colors.border}`, marginTop: 8, paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 14 }
  const heading: React.CSSProperties = { color: colors.textFaint, fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }

  if (loading && !detail) return <div style={panel}><span style={{ color: colors.textMuted, fontSize: 12 }}>Loading details…</span></div>
  if (!detail) return null

  const f = detail.funnel
  const funnelStages: Array<{ label: string; value: number }> = [
    { label: 'Discovered', value: f.discovered },
    { label: 'Recommended', value: f.recommended },
    { label: 'Drafted', value: f.drafted },
    { label: 'Approved', value: f.approved },
    { label: 'Sent', value: f.sent },
  ]

  return (
    <div style={panel}>
      {/* Guided walkthrough: where this mission is in the loop + what's next */}
      <MissionGuide detail={detail} />

      {/* Operator-loop funnel strip */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'stretch' }}>
        {funnelStages.map(st => (
          <div key={st.label} style={{ flex: '1 1 80px', border: `1px solid ${colors.border}`, borderRadius: 8, padding: '8px 10px' }}>
            <div style={{ color: colors.text, fontSize: 18, fontWeight: 700 }}>{st.value}</div>
            <div style={{ color: colors.textFaint, fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>{st.label}</div>
          </div>
        ))}
      </div>

      {/* Score & recommend */}
      {canManage && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button style={s.btnSm} disabled={busy.score} onClick={score}>
            {busy.score ? 'Scoring…' : 'Score & recommend'}
          </button>
          <span style={{ color: colors.textFaint, fontSize: 12 }}>
            Scores discovered prospects and generates outreach recommendations.
          </span>
        </div>
      )}

      {/* Send readiness */}
      <div>
        <div style={heading}>Send readiness</div>
        {detail.sendReadiness.ready ? (
          <div style={{ color: colors.green, fontSize: 13, marginTop: 4 }}>✓ Ready to send — SMTP and compliance details are configured.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
            {detail.sendReadiness.checks.filter(c => !c.ok).map(c => (
              <div key={c.name} style={{ fontSize: 12 }}>
                <span style={{ color: colors.amber }}>• {c.label}</span>
                <span style={{ color: colors.textFaint }}> — {c.hint}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <div style={heading}>Playbook</div>
        <div style={{ color: colors.textMuted, fontSize: 13, marginTop: 4 }}>
          {detail.playbook ? detail.playbook.label : 'No playbook — uses workspace ICP'}
        </div>
      </div>

      <div>
        <div style={heading}>Action queue</div>
        {detail.intents.length === 0 ? (
          <div style={{ color: colors.textFaint, fontSize: 12, marginTop: 4 }}>No pending outreach yet — discover prospects, then Score &amp; recommend to populate it.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 6 }}>
            {detail.intents.map(i => {
              const pid = i.prospect?.id
              const why = i.recommendation?.reasoning || i.messageAngle || null
              return (
                <div key={i.id} style={{ border: `1px solid ${colors.border}`, borderRadius: 8, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13 }}>
                    <span style={{ color: colors.text, fontWeight: 600 }}>{i.prospect?.companyName ?? 'Unknown'}</span>
                    <span style={{ color: colors.textMuted }}>{i.status}{i.prospect ? ` · score ${i.prospect.opportunityScore}` : ''}</span>
                  </div>
                  {why && <div style={{ color: colors.textMuted, fontSize: 12 }}>{why}</div>}
                  {i.status === 'DRAFTED' && i.draftSubject && (
                    <div style={{ background: colors.bg, border: `1px solid ${colors.border}`, borderRadius: 6, padding: '6px 8px' }}>
                      <div style={{ color: colors.text, fontSize: 12, fontWeight: 600 }}>{i.draftSubject}</div>
                      {i.draftBody && <div style={{ color: colors.textMuted, fontSize: 12, marginTop: 4, whiteSpace: 'pre-wrap' }}>{i.draftBody}</div>}
                    </div>
                  )}
                  {canManage && pid && (
                    <div style={{ display: 'flex', gap: 8 }}>
                      {i.status === 'PROPOSED' && (
                        <button style={s.btnSm} disabled={busy[`draft:${i.id}`]} onClick={() => intentAction(pid, i.id, 'draft', 'Draft generated')}>
                          {busy[`draft:${i.id}`] ? 'Drafting…' : 'Generate draft'}
                        </button>
                      )}
                      {i.status === 'DRAFTED' && (
                        <button style={s.btnSm} disabled={busy[`approve:${i.id}`]} onClick={() => intentAction(pid, i.id, 'approve', 'Outreach approved')}>
                          {busy[`approve:${i.id}`] ? 'Approving…' : 'Approve'}
                        </button>
                      )}
                      {(i.status === 'PROPOSED' || i.status === 'DRAFTED') && (
                        <button style={{ ...s.btnSm, border: `1px solid ${colors.border}` }} disabled={busy[`reject:${i.id}`]} onClick={() => intentAction(pid, i.id, 'reject', 'Outreach rejected')}>
                          {busy[`reject:${i.id}`] ? 'Rejecting…' : 'Reject'}
                        </button>
                      )}
                      {i.status === 'APPROVED' && <span style={{ color: colors.green, fontSize: 12, alignSelf: 'center' }}>✓ Approved</span>}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Engagement — the loop tail: what actually went out and came back */}
      <div>
        <div style={heading}>Engagement</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
          {[
            { label: 'Sent', value: String(detail.engagement.sent) },
            { label: 'Replied', value: String(detail.engagement.replied) },
            { label: 'Reply rate', value: `${Math.round(detail.engagement.replyRate * 100)}%` },
            ...(detail.engagement.bounced > 0 ? [{ label: 'Bounced', value: String(detail.engagement.bounced) }] : []),
          ].map(st => (
            <div key={st.label} style={{ flex: '1 1 70px', border: `1px solid ${colors.border}`, borderRadius: 8, padding: '6px 8px' }}>
              <div style={{ color: colors.text, fontSize: 16, fontWeight: 700 }}>{st.value}</div>
              <div style={{ color: colors.textFaint, fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>{st.label}</div>
            </div>
          ))}
        </div>
        {detail.engagement.sent === 0 ? (
          <div style={{ color: colors.textFaint, fontSize: 12, marginTop: 6 }}>Nothing sent yet — approve drafts and run the campaign to start engagement.</div>
        ) : detail.recentSends.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
            {detail.recentSends.map(sd => (
              <div key={sd.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12 }}>
                <span style={{ color: colors.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sd.toEmail} · {sd.subject}</span>
                <span style={{ flexShrink: 0, color: sd.status === 'REPLIED' ? colors.green : (sd.status === 'BOUNCED' || sd.status === 'FAILED') ? colors.red : colors.textFaint }}>
                  {sd.status === 'REPLIED' && sd.replyIntent ? `replied · ${sd.replyIntent}` : sd.status.toLowerCase()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Learning — is the loop improving the model? */}
      <div>
        <div style={heading}>Learning</div>
        <div style={{ color: colors.textMuted, fontSize: 13, marginTop: 4 }}>
          {detail.learning.totalOutcomes === 0
            ? 'No outcomes recorded yet — the scoring model learns once replies and outcomes come in.'
            : `Scoring model updated ${detail.learning.updateCount}× from ${detail.learning.totalOutcomes} outcome${detail.learning.totalOutcomes === 1 ? '' : 's'}${detail.learning.lastWeightUpdate ? ` · last ${new Date(detail.learning.lastWeightUpdate).toLocaleDateString()}` : ''}.`}
        </div>
      </div>

      <div>
        <div style={heading}>Top prospects</div>
        {detail.prospects.length === 0 ? (
          <div style={{ color: colors.textFaint, fontSize: 12, marginTop: 4 }}>None discovered for this mission yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
            {detail.prospects.map(p => (
              <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13 }}>
                <span style={{ color: colors.text }}>{p.companyName}{p.industry ? ` · ${p.industry}` : ''}</span>
                <span style={{ color: colors.textMuted }}>score {p.opportunityScore}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <div style={heading}>Discovery history</div>
        {detail.discoveryRuns.length === 0 ? (
          <div style={{ color: colors.textFaint, fontSize: 12, marginTop: 4 }}>No discovery runs yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
            {detail.discoveryRuns.map(r => (
              <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12 }}>
                <span style={{ color: colors.textMuted }}>{r.source}</span>
                <span style={{ color: r.status === 'FAILED' ? colors.red : colors.textMuted }}>
                  {r.status === 'FAILED'
                    ? `failed${r.errorMessage ? ` — ${r.errorMessage}` : ''}`
                    : `${r.importedCount} imported · ${r.skippedCount} skipped`}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
