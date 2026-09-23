import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Workspace } from '../types.js'
import { s, colors } from '../styles.js'
import { Spinner } from '../components/Spinner.js'
import { EmptyState } from '../components/ui/EmptyState.js'
import { ErrorBanner } from '../components/ui/ErrorBanner.js'
import { Card } from '../components/ui/Card.js'
import { Badge } from '../components/ui/Badge.js'
import { AiQuickAction } from '../components/AiQuickAction.js'
import type { ApiHook } from '../hooks/useApi.js'
import type { ToastHook } from '../hooks/useToast.js'
import { makeRouteApi } from '../lib/routeApi.js'

type Props = { api: ApiHook; workspace: Workspace | null; toast: ToastHook }

type Reply = {
  id: string
  toEmail: string
  subject: string
  sentAt: string
  repliedAt: string | null
  replyIntent: string | null
  replySummary: string | null
  replyKeyQuote: string | null
  replySuggestedAction: string | null
  replyUrgency: string | null
  replyConfidence: number | null
  replyIsAutoReply: boolean | null
  lead: { id: string; businessName: string; stage: string } | null
}

type InboxResponse = { replies: Reply[]; counts: Record<string, number>; total: number }

// Classification → label + colour. Mirrors the 6 reply classes the analyze-reply
// worker emits.
const CLASS_META: Record<string, { label: string; color: string }> = {
  INTERESTED: { label: 'Interested', color: colors.green },
  REFERRAL: { label: 'Referral', color: colors.blueLight },
  NEEDS_MORE_INFO: { label: 'Needs info', color: colors.amber },
  NOT_NOW: { label: 'Not now', color: colors.amber },
  OUT_OF_OFFICE: { label: 'Auto-reply', color: colors.textFaint },
  NOT_INTERESTED: { label: 'Not interested', color: colors.red },
}

function ConfidenceBar({ value }: { value: number }) {
  const percent = Math.round(value)
  const barColor = percent >= 85 ? colors.green : percent >= 70 ? colors.amber : colors.red
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
      <div style={{ flex: 1, height: 4, background: colors.border, borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${percent}%`, background: barColor }} />
      </div>
      <span style={{ color: colors.textFaint, minWidth: 32 }}>{percent}%</span>
    </div>
  )
}

const URGENCY_LABEL: Record<string, string> = {
  immediate: 'Immediate', this_week: 'This week', this_month: 'This month', nurture: 'Nurture', never: 'No action',
}

function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
}

const FILTERS = ['INTERESTED', 'NEEDS_MORE_INFO', 'NOT_NOW', 'REFERRAL', 'OUT_OF_OFFICE', 'NOT_INTERESTED'] as const

export function InboxView({ api, workspace, toast }: Props) {
  const [data, setData] = useState<InboxResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [filter, setFilter] = useState<string | null>(null)
  const [sendingReplyId, setSendingReplyId] = useState<string | null>(null)
  const [editingReplyId, setEditingReplyId] = useState<string | null>(null)
  const [customBody, setCustomBody] = useState('')
  // One idempotency key per compose session: a double-click or a retry after a
  // network error re-sends the same key, and the server never sends twice.
  const [composeKey, setComposeKey] = useState('')
  const [feedbackReplyId, setFeedbackReplyId] = useState<string | null>(null)
  const [feedbackSending, setFeedbackSending] = useState(false)
  const route = useMemo(() => makeRouteApi(api), [api])

  const loadReqRef = useRef(0)
  const load = useCallback(() => {
    if (!workspace) return
    const reqId = ++loadReqRef.current
    setLoading(true)
    setLoadError(false)
    api<InboxResponse>(`/api/inbox?workspaceId=${workspace.id}${filter ? `&classification=${filter}` : ''}`)
      .then(d => { if (reqId === loadReqRef.current) setData(d) })
      .catch(e => {
        if (reqId !== loadReqRef.current) return
        toast.error(e instanceof Error ? e.message : 'Failed to load replies')
        setLoadError(true)
      })
      .finally(() => { if (reqId === loadReqRef.current) setLoading(false) })
  }, [workspace?.id, filter])

  useEffect(() => { load() }, [load])

  const openComposer = useCallback((replyId: string) => {
    setEditingReplyId(replyId)
    setCustomBody('')
    setComposeKey(newIdempotencyKey())
  }, [])

  // The body is always what the user typed. The AI's "suggested next step" is an
  // internal note to the user, not prospect-facing copy, so it is never sent.
  const handleSendReply = useCallback(async (replyId: string, body: string, idempotencyKey: string) => {
    if (!workspace || !body.trim()) return
    setSendingReplyId(replyId)
    try {
      const response = await route('POST /api/inbox/reply/:replyId/send', {
        params: { replyId },
        body: { workspaceId: workspace.id, body, idempotencyKey },
      })
      if (response.success) {
        toast.success(`✓ Reply sent to ${data?.replies.find(r => r.id === replyId)?.toEmail ?? 'prospect'}`)
        setCustomBody('')
        setEditingReplyId(null)
        load()
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to send reply')
    } finally {
      setSendingReplyId(null)
    }
  }, [workspace?.id, route, toast, load, data])

  const handleClassificationFeedback = useCallback(async (replyId: string, feedback: 'correct' | 'incorrect') => {
    if (!workspace) return
    setFeedbackSending(true)
    try {
      await route('PATCH /api/inbox/reply/:replyId/feedback', {
        params: { replyId },
        body: {
          workspaceId: workspace.id,
          feedback,
        },
      })
      toast.success(feedback === 'correct' ? '✓ Thanks for the feedback!' : '✓ Noted. We\'ll improve this.')
      setFeedbackReplyId(replyId)
      load()
    } catch {
      toast.error('Failed to record feedback')
    } finally {
      setFeedbackSending(false)
    }
  }, [workspace?.id, route, toast, load, data])

  const counts = data?.counts ?? {}
  const total = useMemo(() => Object.values(counts).reduce((a, b) => a + b, 0), [counts])

  if (!workspace) return <div style={s.card}><EmptyState title="No workspace selected" /></div>

  return (
    <div style={s.stack}>
      {loadError && <ErrorBanner message="Failed to load replies." onRetry={load} />}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <p style={{ color: colors.textMuted, fontSize: 13, margin: 0, flex: 1, minWidth: 220 }}>
          Inbox Assistant classifies incoming replies by intent and suggests the best next action. Review, approve, and respond with AI-generated replies.
        </p>
        {/* Contextual AI: analyze an ad-hoc reply (paste-in) right where replies live. */}
        <AiQuickAction kind="reply" api={api} workspace={workspace} toast={toast} />
      </div>

      {/* Filter chips */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <FilterChip label={`All${total ? ` (${total})` : ''}`} active={filter === null} onClick={() => setFilter(null)} color={colors.text} />
        {FILTERS.map(f => {
          const n = counts[f] ?? 0
          if (n === 0 && filter !== f) return null
          const meta = CLASS_META[f]
          return <FilterChip key={f} label={`${meta.label}${n ? ` (${n})` : ''}`} active={filter === f} onClick={() => setFilter(filter === f ? null : f)} color={meta.color} />
        })}
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 40 }}><Spinner /></div>
      ) : !data || data.replies.length === 0 ? (
        <div style={s.card}>
          <EmptyState title="No replies yet" description="Once prospects respond to your outreach, classified replies land here." />
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {data.replies.map(r => {
            const meta = r.replyIntent ? CLASS_META[r.replyIntent] : null
            return (
              <Card key={r.id} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                    <span style={{ color: colors.text, fontWeight: 700, fontSize: 14 }}>{r.lead?.businessName || r.toEmail}</span>
                    {meta && <Badge color={meta.color}>{meta.label}</Badge>}
                    {r.replyIsAutoReply && <span style={{ color: colors.textFaint, fontSize: 11 }}>auto-reply</span>}
                  </span>
                  <span style={{ color: colors.textFaint, fontSize: 12 }}>
                    {r.replyUrgency && URGENCY_LABEL[r.replyUrgency] ? `${URGENCY_LABEL[r.replyUrgency]} · ` : ''}
                    {r.repliedAt ? new Date(r.repliedAt).toLocaleDateString() : ''}
                  </span>
                </div>
                <div style={{ color: colors.textMuted, fontSize: 13 }}>{r.subject}</div>
                {r.replySummary && <div style={{ color: colors.text, fontSize: 13 }}>{r.replySummary}</div>}
                {r.replyKeyQuote && (
                  <div style={{ borderLeft: `2px solid ${colors.border}`, paddingLeft: 10, color: colors.textFaint, fontSize: 13, fontStyle: 'italic' }}>
                    “{r.replyKeyQuote}”
                  </div>
                )}
                {r.replySuggestedAction && (
                  <div style={{ color: colors.blueLight, fontSize: 13 }}>
                    <span style={{ color: colors.textFaint }}>Suggested next step: </span>{r.replySuggestedAction}
                  </div>
                )}
                {r.replyConfidence !== null && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                      <span style={{ color: colors.textFaint, fontSize: 11 }}>Classification confidence</span>
                      {feedbackReplyId !== r.id && (
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button
                            onClick={() => handleClassificationFeedback(r.id, 'correct')}
                            disabled={feedbackSending || sendingReplyId === r.id}
                            style={{
                              background: 'none',
                              border: 'none',
                              cursor: 'pointer',
                              fontSize: 13,
                              padding: '0 4px',
                              color: colors.green,
                              opacity: 0.6,
                              transition: 'opacity 0.15s',
                            }}
                            onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
                            onMouseLeave={e => (e.currentTarget.style.opacity = '0.6')}
                            title="Mark as correct"
                          >
                            👍
                          </button>
                          <button
                            onClick={() => handleClassificationFeedback(r.id, 'incorrect')}
                            disabled={feedbackSending || sendingReplyId === r.id}
                            style={{
                              background: 'none',
                              border: 'none',
                              cursor: 'pointer',
                              fontSize: 13,
                              padding: '0 4px',
                              color: colors.red,
                              opacity: 0.6,
                              transition: 'opacity 0.15s',
                            }}
                            onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
                            onMouseLeave={e => (e.currentTarget.style.opacity = '0.6')}
                            title="Mark as incorrect"
                          >
                            👎
                          </button>
                        </div>
                      )}
                    </div>
                    <ConfidenceBar value={r.replyConfidence} />
                  </div>
                )}
                {editingReplyId === r.id ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
                    <textarea
                      value={customBody}
                      onChange={(e) => setCustomBody(e.target.value)}
                      placeholder={r.replySuggestedAction ? `Write your reply to ${r.toEmail}. Next step: ${r.replySuggestedAction}` : `Write your reply to ${r.toEmail}…`}
                      style={{
                        flex: 1, padding: 8, borderRadius: 4, border: `1px solid ${colors.border}`,
                        fontFamily: 'inherit', fontSize: 13, minHeight: 80, resize: 'vertical',
                        background: colors.border === '#e5e7eb' ? '#f9fafb' : '#1a1a1a',
                        color: colors.text,
                      }}
                    />
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        onClick={() => handleSendReply(r.id, customBody, composeKey)}
                        disabled={sendingReplyId === r.id || !customBody.trim()}
                        style={{
                          flex: 1, padding: '8px 12px', borderRadius: 4, border: 'none',
                          background: colors.green, color: '#fff', fontWeight: 600, cursor: 'pointer',
                          fontSize: 13, opacity: sendingReplyId === r.id || !customBody.trim() ? 0.6 : 1,
                        }}
                      >
                        {sendingReplyId === r.id ? 'Sending...' : 'Send reply'}
                      </button>
                      <button
                        onClick={() => { setEditingReplyId(null); setCustomBody(''); }}
                        style={{
                          padding: '8px 12px', borderRadius: 4, border: `1px solid ${colors.border}`,
                          background: 'transparent', color: colors.text, cursor: 'pointer', fontSize: 13,
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <button
                      onClick={() => openComposer(r.id)}
                      disabled={sendingReplyId === r.id}
                      style={{
                        padding: '6px 12px', borderRadius: 4, border: `1px solid ${colors.border}`,
                        background: 'transparent', color: colors.text, cursor: 'pointer', fontSize: 12,
                      }}
                    >
                      Reply
                    </button>
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

function FilterChip({ label, active, onClick, color }: { label: string; active: boolean; onClick: () => void; color: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        cursor: 'pointer', fontSize: 12, fontWeight: 600, padding: '5px 12px', borderRadius: 99,
        border: `1px solid ${active ? color : colors.border}`,
        background: active ? color + '22' : 'transparent',
        color: active ? color : colors.textMuted,
      }}
    >
      {label}
    </button>
  )
}
