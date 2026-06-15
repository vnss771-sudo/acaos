import React, { useEffect, useState, useCallback } from 'react'
import type { UpdateDraftRequest } from '@acaos/shared'
import type { OutreachDraft, Workspace } from '../types.js'
import { s, colors } from '../styles.js'
import { Spinner, EmptyState } from '../components/Spinner.js'
import type { ApiHook } from '../hooks/useApi.js'
import type { ToastHook } from '../hooks/useToast.js'

type Props = { api: ApiHook; workspace: Workspace | null; toast: ToastHook }

type PendingDraft = OutreachDraft & {
  leadId?: string
  lead: { id: string; businessName: string; email?: string | null; city?: string | null; category?: string | null }
}

export function ApprovalsView({ api, workspace, toast }: Props) {
  const [drafts, setDrafts] = useState<PendingDraft[]>([])
  const [loading, setLoading] = useState(true)
  const [edits, setEdits] = useState<Record<string, { subject: string; emailBody: string }>>({})
  const [busy, setBusy] = useState<Record<string, boolean>>({})

  const load = useCallback(() => {
    if (!workspace) return
    setLoading(true)
    api<{ drafts: PendingDraft[] }>(`/api/leads/approvals/pending?workspaceId=${workspace.id}`)
      .then(d => setDrafts(d.drafts || []))
      .catch(e => toast.error(e instanceof Error ? e.message : 'Failed to load approvals'))
      .finally(() => setLoading(false))
  }, [api, workspace?.id, toast])

  useEffect(() => { load() }, [workspace?.id])

  function edited(d: PendingDraft) {
    const e = edits[d.id]
    return e && (e.subject !== d.subject || e.emailBody !== d.emailBody)
  }

  function setBusyFor(id: string, v: boolean) { setBusy(prev => ({ ...prev, [id]: v })) }
  function remove(id: string) { setDrafts(prev => prev.filter(d => d.id !== id)) }

  async function save(d: PendingDraft) {
    const e = edits[d.id]
    if (!e || !edited(d)) return
    setBusyFor(d.id, true)
    try {
      const body: UpdateDraftRequest = { subject: e.subject, emailBody: e.emailBody }
      const r = await api<{ draft: OutreachDraft }>(`/api/leads/${d.lead.id}/drafts/${d.id}`, { method: 'PATCH', body: JSON.stringify(body) })
      setDrafts(prev => prev.map(x => x.id === d.id ? { ...x, subject: r.draft.subject, emailBody: r.draft.emailBody } : x))
      toast.success('Draft updated')
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Save failed') }
    finally { setBusyFor(d.id, false) }
  }

  async function decide(d: PendingDraft, action: 'approve' | 'reject') {
    setBusyFor(d.id, true)
    try {
      if (action === 'approve' && edited(d)) await save(d)
      await api(`/api/leads/${d.lead.id}/drafts/${d.id}/${action}`, { method: 'POST' })
      remove(d.id)
      toast.success(action === 'approve' ? 'Approved — ready to send' : 'Rejected')
    } catch (err) { toast.error(err instanceof Error ? err.message : `${action} failed`) }
    finally { setBusyFor(d.id, false) }
  }

  if (!workspace) return null
  if (loading) return <Spinner />

  return (
    <div>
      <p style={{ color: colors.textMuted, fontSize: 13, margin: '0 0 20px' }}>
        Review AI-drafted outreach before it sends. Edit the copy, then approve or reject.
        {drafts.length > 0 && <strong style={{ color: colors.text }}> · {drafts.length} pending</strong>}
      </p>

      {drafts.length === 0 ? (
        <EmptyState message="No drafts awaiting review. Approved drafts send on the next campaign run." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {drafts.map(d => {
            const e = edits[d.id] ?? { subject: d.subject, emailBody: d.emailBody }
            const isBusy = busy[d.id]
            return (
              <div key={d.id} style={{ ...s.card, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
                  <span style={{ color: colors.text, fontWeight: 700, fontSize: 14 }}>{d.lead.businessName}</span>
                  <span style={{ color: colors.textFaint, fontSize: 12 }}>{d.lead.email || 'no email'}</span>
                </div>
                <div>
                  <label style={s.label}>Subject</label>
                  <input
                    style={s.input}
                    value={e.subject}
                    disabled={isBusy}
                    onChange={ev => setEdits(prev => ({ ...prev, [d.id]: { ...e, subject: ev.target.value } }))}
                  />
                </div>
                <div>
                  <label style={s.label}>Body</label>
                  <textarea
                    style={{ ...s.textarea, minHeight: 120 }}
                    value={e.emailBody}
                    disabled={isBusy}
                    onChange={ev => setEdits(prev => ({ ...prev, [d.id]: { ...e, emailBody: ev.target.value } }))}
                  />
                </div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  {edited(d) && (
                    <button style={s.btnSecondary} disabled={isBusy} onClick={() => save(d)}>Save edits</button>
                  )}
                  <button style={{ ...s.btnSm, background: '#7f1d1d' }} disabled={isBusy} onClick={() => decide(d, 'reject')}>Reject</button>
                  <button style={{ ...s.btn, background: '#16a34a' }} disabled={isBusy} onClick={() => decide(d, 'approve')}>
                    {edited(d) ? 'Save & Approve' : 'Approve'}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
