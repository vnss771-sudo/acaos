import React, { useEffect, useState, useCallback, useMemo } from 'react'
import type { UpdateDraftRequest } from '@acaos/shared'
import type { OutreachDraft, Workspace } from '../types.js'
import { s, colors } from '../styles.js'
import { Spinner, EmptyState } from '../components/Spinner.js'
import { Card } from '../components/ui/Card.js'
import { analyzeDraft } from '../lib/draftRisk.js'
import { makeRouteApi } from '../lib/routeApi.js'
import type { ApiHook } from '../hooks/useApi.js'
import type { ToastHook } from '../hooks/useToast.js'

type Props = { api: ApiHook; workspace: Workspace | null; toast: ToastHook; canManage?: boolean }

type PendingDraft = OutreachDraft & {
  leadId?: string
  lead: { id: string; businessName: string; email?: string | null; city?: string | null; category?: string | null }
}

export function ApprovalsView({ api, workspace, toast, canManage = false }: Props) {
  const route = useMemo(() => makeRouteApi(api), [api])
  const [drafts, setDrafts] = useState<PendingDraft[]>([])
  const [loading, setLoading] = useState(true)
  const [edits, setEdits] = useState<Record<string, { subject: string; emailBody: string }>>({})
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [batchRunning, setBatchRunning] = useState(false)

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
  function remove(id: string) {
    setDrafts(prev => prev.filter(d => d.id !== id))
    setSelected(prev => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const allSelected = drafts.length > 0 && selected.size === drafts.length
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(drafts.map(d => d.id)))
  }

  async function save(d: PendingDraft) {
    const e = edits[d.id]
    if (!e || !edited(d)) return
    setBusyFor(d.id, true)
    try {
      const body: UpdateDraftRequest = { subject: e.subject, emailBody: e.emailBody }
      const r = await route('PATCH /api/leads/:id/drafts/:draftId', { params: { id: d.lead.id, draftId: d.id }, body }) as { draft: OutreachDraft }
      setDrafts(prev => prev.map(x => x.id === d.id ? { ...x, subject: r.draft.subject, emailBody: r.draft.emailBody } : x))
      toast.success('Draft updated')
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Save failed') }
    finally { setBusyFor(d.id, false) }
  }

  // Single source of truth for applying a decision to one draft. Used by both the
  // per-card buttons and the batch bar (which loops it over the selection — the
  // backend has no batch endpoint, so this calls the existing per-draft route).
  async function runDecision(d: PendingDraft, action: 'approve' | 'reject') {
    if (action === 'approve' && edited(d)) {
      const e = edits[d.id]!
      const body: UpdateDraftRequest = { subject: e.subject, emailBody: e.emailBody }
      await route('PATCH /api/leads/:id/drafts/:draftId', { params: { id: d.lead.id, draftId: d.id }, body })
    }
    await route('POST /api/leads/:id/drafts/:draftId/:action', { params: { id: d.lead.id, draftId: d.id, action } })
    remove(d.id)
  }

  async function decide(d: PendingDraft, action: 'approve' | 'reject') {
    setBusyFor(d.id, true)
    try {
      await runDecision(d, action)
      toast.success(action === 'approve' ? 'Approved — ready to send' : 'Rejected')
    } catch (err) { toast.error(err instanceof Error ? err.message : `${action} failed`) }
    finally { setBusyFor(d.id, false) }
  }

  async function batchDecide(action: 'approve' | 'reject') {
    const targets = drafts.filter(d => selected.has(d.id))
    if (targets.length === 0 || batchRunning) return
    setBatchRunning(true)
    let ok = 0
    let failed = 0
    for (const d of targets) {
      setBusyFor(d.id, true)
      try { await runDecision(d, action); ok++ }
      catch { failed++ }
      finally { setBusyFor(d.id, false) }
    }
    setBatchRunning(false)
    if (ok > 0) toast.success(`${ok} ${action === 'approve' ? 'approved — ready to send' : 'rejected'}`)
    if (failed > 0) toast.error(`${failed} could not be ${action === 'approve' ? 'approved' : 'rejected'}`)
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
          {canManage && (
            <Card style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', color: colors.textMuted, fontSize: 13 }}>
                <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all drafts" />
                Select all
              </label>
              <span style={{ color: colors.textFaint, fontSize: 12 }}>{selected.size} selected</span>
              <div style={{ flex: 1 }} />
              <button
                style={{ ...s.btnSm, background: '#7f1d1d', opacity: selected.size === 0 || batchRunning ? 0.5 : 1 }}
                disabled={selected.size === 0 || batchRunning}
                onClick={() => batchDecide('reject')}
              >
                Reject selected
              </button>
              <button
                style={{ ...s.btn, background: '#16a34a', opacity: selected.size === 0 || batchRunning ? 0.5 : 1 }}
                disabled={selected.size === 0 || batchRunning}
                onClick={() => batchDecide('approve')}
              >
                Approve selected
              </button>
            </Card>
          )}
          {drafts.map(d => {
            const e = edits[d.id] ?? { subject: d.subject, emailBody: d.emailBody }
            const isBusy = busy[d.id]
            const risks = analyzeDraft(e.subject, e.emailBody)
            return (
              <Card key={d.id} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    {canManage && (
                      <input
                        type="checkbox"
                        checked={selected.has(d.id)}
                        disabled={isBusy}
                        onChange={() => toggle(d.id)}
                        aria-label={`Select ${d.lead.businessName}`}
                      />
                    )}
                    <span style={{ color: colors.text, fontWeight: 700, fontSize: 14 }}>{d.lead.businessName}</span>
                  </span>
                  <span style={{ color: colors.textFaint, fontSize: 12 }}>{d.lead.email || 'no email'}</span>
                </div>
                <div>
                  <label style={s.label} htmlFor="approvals-field-0">Subject</label>
                  <input id="approvals-field-0"
                    style={s.input}
                    value={e.subject}
                    disabled={isBusy || !canManage}
                    onChange={ev => setEdits(prev => ({ ...prev, [d.id]: { ...e, subject: ev.target.value } }))}
                  />
                </div>
                <div>
                  <label style={s.label} htmlFor="approvals-field-1">Body</label>
                  <textarea id="approvals-field-1"
                    style={{ ...s.textarea, minHeight: 120 }}
                    value={e.emailBody}
                    disabled={isBusy || !canManage}
                    onChange={ev => setEdits(prev => ({ ...prev, [d.id]: { ...e, emailBody: ev.target.value } }))}
                  />
                </div>
                {risks.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }} aria-label="Draft risk checks">
                    {risks.map(r => {
                      const tone = r.level === 'warn' ? colors.red : colors.amber
                      return (
                        <span key={r.id} title={r.message} style={{
                          display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600,
                          color: tone, background: tone + '18', border: `1px solid ${tone}44`,
                          borderRadius: 99, padding: '2px 8px',
                        }}>
                          <span aria-hidden="true">{r.level === 'warn' ? '!' : '⚠'}</span>
                          {r.message}
                        </span>
                      )
                    })}
                  </div>
                )}
                {canManage && (
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    {edited(d) && (
                      <button style={s.btnSecondary} disabled={isBusy} onClick={() => save(d)}>Save edits</button>
                    )}
                    <button style={{ ...s.btnSm, background: '#7f1d1d' }} disabled={isBusy} onClick={() => decide(d, 'reject')}>Reject</button>
                    <button style={{ ...s.btn, background: '#16a34a' }} disabled={isBusy} onClick={() => decide(d, 'approve')}>
                      {edited(d) ? 'Save & Approve' : 'Approve'}
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
