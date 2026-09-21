import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import type { Lead, Campaign, OutreachDraft, LeadEvidenceRow } from '../../types.js'
import { STAGES, STAGE_COLOR, TIER_COLOR, getScoreTier } from '../../types.js'
import { s, colors } from '../../styles.js'
import { Spinner } from '../Spinner.js'
import { makeRouteApi } from '../../lib/routeApi.js'
import type { ApiHook } from '../../hooks/useApi.js'
import type { ToastHook } from '../../hooks/useToast.js'
import { LeadBrief } from './LeadBrief.js'
import { JobProgressBar } from './JobProgressBar.js'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')

export function LeadDetailPanel({ lead, api, toast, onUpdate, onClose, campaigns }: {
  lead: Lead; api: ApiHook; toast: ToastHook
  onUpdate: (l: Lead) => void; onClose: () => void
  campaigns: Campaign[]
}) {
  const route = useMemo(() => makeRouteApi(api), [api])
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState({ ...lead })
  const [drafts, setDrafts] = useState<OutreachDraft[]>([])
  const [evidenceRows, setEvidenceRows] = useState<LeadEvidenceRow[]>([])
  const [saving, setSaving] = useState(false)
  const [activeJobs, setActiveJobs] = useState<Record<string, { state: string; progress: number }>>({})
  const eventSourcesRef = useRef<Map<string, EventSource>>(new Map())

  const loadEvidence = useCallback(() => {
    api<{ evidence: LeadEvidenceRow[] }>(`/api/leads/${lead.id}/evidence`).then(d => setEvidenceRows(d.evidence || [])).catch(() => {})
  }, [api, lead.id])

  useEffect(() => {
    api<{ drafts: OutreachDraft[] }>(`/api/leads/${lead.id}/drafts`).then(d => setDrafts(d.drafts)).catch(() => {})
    loadEvidence()
    return () => { eventSourcesRef.current.forEach(es => es.close()) }
  }, [lead.id])

  async function save() {
    setSaving(true)
    try {
      const d = await route('PATCH /api/leads/:id', { params: { id: lead.id }, body: form }) as { lead: Lead }
      onUpdate(d.lead)
      setEditing(false)
      toast.success('Lead updated')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Update failed') }
    finally { setSaving(false) }
  }

  async function streamJob(queue: string, jobId: string, type: string, onDone: () => void) {
    // Exchange the session for a short-lived, single-use SSE ticket instead of
    // putting a long-lived JWT in the EventSource URL.
    let ticket: string
    try {
      const r = await route('POST /api/jobs/events/ticket')
      ticket = r.ticket
    } catch {
      return
    }

    const es = new EventSource(
      `${API_BASE}/api/jobs/events/${queue}/${jobId}?ticket=${encodeURIComponent(ticket)}`
    )

    setActiveJobs(j => ({ ...j, [type]: { state: 'waiting', progress: 0 } }))
    eventSourcesRef.current.set(type, es)

    es.addEventListener('progress', e => {
      const data = JSON.parse(e.data)
      setActiveJobs(j => ({ ...j, [type]: { state: data.state, progress: data.progress ?? 0 } }))
    })

    es.addEventListener('done', e => {
      const data = JSON.parse(e.data)
      setActiveJobs(j => ({ ...j, [type]: { state: data.state, progress: 100 } }))
      es.close()
      eventSourcesRef.current.delete(type)
      if (data.state === 'completed') {
        toast.success(`${type === 'research' ? 'Research' : 'Outreach'} complete`)
        onDone()
      } else {
        toast.error(`${type} job failed`)
      }
    })

    es.onerror = () => {
      es.close()
      eventSourcesRef.current.delete(type)
      setActiveJobs(j => { const n = { ...j }; delete n[type]; return n })
    }
  }

  async function enqueue(type: 'research' | 'outreach', opts: { override?: boolean } = {}) {
    try {
      const d = await route('POST /api/jobs/:type', { params: { type }, body: { leadId: lead.id, ...(opts.override ? { override: true } : {}) } })
      streamJob(d.queue, d.jobId, type, async () => {
        // Refresh lead data after completion
        try {
          const updated = await api<{ lead: Lead }>(`/api/leads/${lead.id}`)
          onUpdate(updated.lead)
          if (type === 'research') loadEvidence()
          if (type === 'outreach') {
            const ds = await api<{ drafts: OutreachDraft[] }>(`/api/leads/${lead.id}/drafts`)
            setDrafts(ds.drafts)
          }
        } catch { /* ignore */ }
      })
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to queue job') }
  }

  async function moveStage(stage: string) {
    try {
      const d = await route('PATCH /api/leads/:id', { params: { id: lead.id }, body: { stage } }) as { lead: Lead }
      onUpdate(d.lead)
      toast.success(`Moved to ${stage}`)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Update failed') }
  }

  const ff = (field: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [field]: e.target.value }))

  const tier = getScoreTier(lead.score)

  return (
    <div style={{ ...s.card, borderColor: colors.blue + '44' }}>
      <div style={{ ...s.flexBetween, marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h3 style={{ color: colors.text, margin: 0, fontSize: 16 }}>{lead.businessName}</h3>
          {lead.score > 0 && <span style={s.badge(TIER_COLOR[tier])}>{tier} · {lead.score}</span>}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button style={s.btnSm} onClick={() => setEditing(v => !v)}>{editing ? 'Cancel' : 'Edit'}</button>
          <button style={s.btnSm} aria-label="Close detail panel" onClick={onClose}>✕</button>
        </div>
      </div>

      {editing ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
          {[
            { label: 'Business Name', field: 'businessName' },
            { label: 'Contact Name', field: 'contactName' },
            { label: 'Email', field: 'email' },
            { label: 'Phone', field: 'phone' },
            { label: 'Website', field: 'website' },
            { label: 'City', field: 'city' },
            { label: 'Category', field: 'category' }
          ].map(({ label, field }) => (
            <div key={field}>
              <label style={s.label} htmlFor="leads-field-0">{label}</label>
              <input id="leads-field-0" style={s.input} value={(form as unknown as Record<string, string | number>)[field] as string ?? ''} onChange={ff(field)} />
            </div>
          ))}
          <div>
            <label style={s.label} htmlFor="leads-field-1">Campaign</label>
            <select id="leads-field-1" style={s.input} value={form.campaignId ?? ''} onChange={ff('campaignId')}>
              <option value="">No campaign</option>
              {campaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div style={{ gridColumn: '1/-1' }}>
            <label style={s.label} htmlFor="leads-field-2">Notes</label>
            <textarea id="leads-field-2" style={{ ...s.textarea, height: 80 }} value={form.notes ?? ''} onChange={ff('notes')} />
          </div>
          <div style={{ gridColumn: '1/-1', display: 'flex', gap: 8 }}>
            <button style={s.btn} disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save Changes'}</button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 }}>
          {[
            { label: 'Email', value: lead.email },
            { label: 'Phone', value: lead.phone },
            { label: 'Website', value: lead.website },
            { label: 'City', value: lead.city },
            { label: 'Category', value: lead.category },
            { label: 'Contact', value: lead.contactName },
            { label: 'Last Contact', value: lead.lastContactedAt ? new Date(lead.lastContactedAt).toLocaleDateString() : null }
          ].filter(x => x.value).map(({ label, value }) => (
            <div key={label}>
              <span style={{ color: colors.textFaint, fontSize: 12 }}>{label}: </span>
              <span style={{ color: colors.text, fontSize: 14 }}>{value}</span>
            </div>
          ))}
        </div>
      )}

      {/* Poor-fit suppression banner */}
      {lead.outreachSkippedAt && (
        <div style={{ ...s.cardInner, borderLeft: `3px solid ${colors.amber}`, marginBottom: 16 }}>
          <div style={{ color: colors.amber, fontWeight: 700, fontSize: 13 }}>⏭ Outreach skipped — poor fit</div>
          <div style={{ color: colors.textMuted, fontSize: 12, marginTop: 4, lineHeight: 1.5 }}>
            {lead.outreachSkipReason || 'Research recommended skipping this lead.'} No draft was generated. Use “Generate anyway” to draft it into manual review.
          </div>
        </div>
      )}

      {/* Lead brief: the AI research as one clean, plain-language briefing
          (summary, why they fit, the way in, caveats, next step). */}
      {(lead.aiSummary || lead.outreachAngle || lead.aiIntelligence || evidenceRows.length > 0) && (
        <LeadBrief lead={lead} intel={lead.aiIntelligence ?? {}} rows={evidenceRows} />
      )}

      {/* Outreach drafts */}
      {drafts.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={s.sectionHeader}>Outreach Drafts ({drafts.length})</div>
          {drafts.map(d => (
            <div key={d.id} style={{ ...s.cardInner, marginBottom: 8 }}>
              <div style={{ color: colors.text, fontWeight: 600, marginBottom: 4, fontSize: 13 }}>{d.subject}</div>
              <div style={{ color: colors.textMuted, fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{d.emailBody}</div>
              {d.followup && (
                <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${colors.border}` }}>
                  <div style={{ color: colors.textFaint, fontSize: 11, marginBottom: 4 }}>FOLLOW-UP</div>
                  <div style={{ color: colors.textMuted, fontSize: 13 }}>{d.followup}</div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* AI action buttons + job progress */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <button
          style={{ ...s.btnSm, background: '#1e3a5f' }}
          disabled={!!activeJobs.research}
          onClick={() => enqueue('research')}
        >
          {activeJobs.research ? <><Spinner size={12} /> Researching…</> : '✦ Research'}
        </button>
        <button
          style={{ ...s.btnSm, background: lead.outreachSkippedAt ? '#5e3a1d' : '#2d1d5e' }}
          disabled={!!activeJobs.outreach}
          onClick={() => enqueue('outreach', { override: !!lead.outreachSkippedAt })}
          title={lead.outreachSkippedAt ? 'Research recommended skipping; generate anyway into manual review' : undefined}
        >
          {activeJobs.outreach
            ? <><Spinner size={12} /> Generating…</>
            : lead.outreachSkippedAt ? '✉ Generate anyway' : '✉ Generate Outreach'}
        </button>
      </div>

      {Object.entries(activeJobs).map(([type, job]) => (
        <JobProgressBar key={type} state={job.state} progress={job.progress} />
      ))}

      {/* Stage selector */}
      <div style={{ marginTop: 12 }}>
        <div style={s.label}>Pipeline Stage</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {STAGES.map(stage => (
            <button
              key={stage}
              onClick={() => moveStage(stage)}
              style={{
                ...s.btnSm,
                background: lead.stage === stage ? (STAGE_COLOR[stage] || colors.textFaint) : '#1f2937',
                color: lead.stage === stage ? '#fff' : colors.textMuted,
                fontWeight: lead.stage === stage ? 700 : 400,
                fontSize: 11
              }}
            >
              {stage}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
