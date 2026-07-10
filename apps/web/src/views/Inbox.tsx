import React, { useEffect, useMemo, useState } from 'react'
import type { Workspace } from '../types.js'
import { s, colors } from '../styles.js'
import { Spinner, EmptyState } from '../components/Spinner.js'
import { Card } from '../components/ui/Card.js'
import { Badge } from '../components/ui/Badge.js'
import { AiQuickAction } from '../components/AiQuickAction.js'
import type { ApiHook } from '../hooks/useApi.js'
import type { ToastHook } from '../hooks/useToast.js'

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

const URGENCY_LABEL: Record<string, string> = {
  immediate: 'Immediate', this_week: 'This week', this_month: 'This month', nurture: 'Nurture', never: 'No action',
}

const FILTERS = ['INTERESTED', 'NEEDS_MORE_INFO', 'NOT_NOW', 'REFERRAL', 'OUT_OF_OFFICE', 'NOT_INTERESTED'] as const

export function InboxView({ api, workspace, toast }: Props) {
  const [data, setData] = useState<InboxResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState<string | null>(null)

  useEffect(() => {
    if (!workspace) return
    let cancelled = false
    setLoading(true)
    api<InboxResponse>(`/api/inbox?workspaceId=${workspace.id}${filter ? `&classification=${filter}` : ''}`)
      .then(d => { if (!cancelled) setData(d) })
      .catch(e => { if (!cancelled) toast.error(e instanceof Error ? e.message : 'Failed to load replies') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [workspace?.id, filter])

  const counts = data?.counts ?? {}
  const total = useMemo(() => Object.values(counts).reduce((a, b) => a + b, 0), [counts])

  if (!workspace) return <div style={s.card}><EmptyState message="No workspace selected" icon="✉" /></div>

  return (
    <div style={s.stack}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <p style={{ color: colors.textMuted, fontSize: 13, margin: 0, flex: 1, minWidth: 220 }}>
          Replies to your outreach, classified by intent. ACAOS suggests the next move for each.
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
          <EmptyState message="No replies yet. Once prospects respond to your outreach, classified replies land here." icon="✉" />
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
                    <span style={{ color: colors.textFaint }}>Suggested: </span>{r.replySuggestedAction}
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
