import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import type { CreateLeadRequest, ImportLeadsRequest, LeadInput } from '@acaos/shared'
import type { Lead, Workspace, Campaign, OutreachDraft, LeadIntelligence, LeadEvidenceRow } from '../types.js'
import { STAGES, STAGE_COLOR, TIER_COLOR, getScoreTier } from '../types.js'
import { s, colors } from '../styles.js'
import { Spinner, EmptyState } from '../components/Spinner.js'
import { makeRouteApi } from '../lib/routeApi.js'
import type { ApiHook } from '../hooks/useApi.js'
import type { ToastHook } from '../hooks/useToast.js'

type Props = { api: ApiHook; workspace: Workspace | null; toast: ToastHook; canManage?: boolean }

const BLANK_FORM = {
  businessName: '', contactName: '', email: '', phone: '',
  website: '', city: '', category: '', notes: '', score: ''
}

// RFC-4180 compliant CSV parser. Handles quoted fields containing commas,
// newlines, and escaped double-quotes ("").
function parseCsvLine(line: string): string[] {
  const fields: string[] = []
  let i = 0
  while (i <= line.length) {
    if (line[i] === '"') {
      let field = ''
      i++ // skip opening quote
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') {
          field += '"'; i += 2
        } else if (line[i] === '"') {
          i++; break
        } else {
          field += line[i++]
        }
      }
      fields.push(field)
      if (line[i] === ',') i++
    } else {
      const end = line.indexOf(',', i)
      if (end === -1) { fields.push(line.slice(i).trim()); break }
      fields.push(line.slice(i, end).trim())
      i = end + 1
    }
  }
  return fields
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/)
  if (lines.length < 2) return []
  const headers = parseCsvLine(lines[0])
  return lines.slice(1).filter(l => l.trim()).map(line => {
    const vals = parseCsvLine(line)
    const row: Record<string, string> = {}
    headers.forEach((h, i) => { row[h] = vals[i] ?? '' })
    return row
  })
}

function ScorePill({ score }: { score: number }) {
  if (score <= 0) return <span style={{ color: colors.textFaint, fontSize: 13 }}>–</span>
  const tier = getScoreTier(score)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span style={s.badge(TIER_COLOR[tier])}>{tier}</span>
      <span style={{ color: colors.amber, fontSize: 13, fontWeight: 700 }}>{score}</span>
    </span>
  )
}

const CONFIDENCE_COLOR: Record<string, string> = {
  high: colors.green,
  medium: colors.amber,
  low: colors.textFaint,
}
// Plain-language "what to do next" phrasing for the lead brief, instead of
// surfacing the raw enum (auto_draft / manual_review_then_draft / skip) to the user.
const ACTION_NEXT_STEP: Record<string, string> = {
  auto_draft: 'Ready to draft and reach out — the fit is strong and the evidence holds up.',
  manual_review_then_draft: 'Review, then draft — the signals are promising but unconfirmed, so a person should eyeball it before sending.',
  skip: 'Skip for now — not a strong enough fit to spend outreach on.',
}

// One section of the lead brief: a sentence-case heading over its content. Kept
// deliberately plain (no ALL-CAPS labels, no enum badges) so the whole card reads
// like a short written briefing rather than a dump of structured fields.
function BriefSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ color: colors.textFaint, fontSize: 12, fontWeight: 600, marginBottom: 5 }}>{title}</div>
      {children}
    </div>
  )
}

const briefList: React.CSSProperties = { margin: 0, paddingLeft: 18, color: '#cbd5e1', fontSize: 13, lineHeight: 1.7 }

// The lead brief: the AI research presented as a clean, plain-language briefing
// — fit, who they are, why they fit, the way in, the caveats, and the next step —
// instead of exposing the raw scoring fields, provenance enums, and action codes.
// It still draws from the same data (the persisted evidence rows preferred over the
// JSON snapshot, the deterministic score rationale, the risk flags), just rendered
// for a person to read. Renders nothing when there's no research yet.
function LeadBrief({ lead, intel, rows }: { lead: Lead; intel: LeadIntelligence; rows?: LeadEvidenceRow[] }) {
  const evidence = rows && rows.length > 0
    ? rows.map((r) => ({ text: r.signal, sourceUrl: r.sourceUrl }))
    : (intel.evidence ?? []).map((e) => ({ text: e.signal, sourceUrl: e.sourceUrl }))
  // Prefer the deterministic score rationale; fall back to the evidence signals.
  const reasons = (intel.topReasons && intel.topReasons.length > 0)
    ? intel.topReasons.map((t) => ({ text: t, sourceUrl: undefined as string | null | undefined }))
    : evidence
  const riskFlags = intel.riskFlags ?? []
  const score = lead.score > 0 ? lead.score : (intel.finalScore ?? 0)

  // Notable, positive facts only — surface them as a short prose line, not labelled
  // fields. (A "not hiring" or "low maturity" non-signal would just add noise.)
  const facts: string[] = []
  if (intel.estimatedTeamSize) facts.push(`likely ${intel.estimatedTeamSize} people`)
  if (intel.digitalMaturity) facts.push(`${intel.digitalMaturity} digital maturity`)
  if (intel.hiringSignals) facts.push('actively hiring')

  const hasContent = lead.aiSummary || reasons.length > 0 || lead.outreachAngle ||
    riskFlags.length > 0 || intel.recommendedAction || facts.length > 0
  if (!hasContent) return null

  return (
    <div style={{ ...s.cardInner, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={{ color: colors.text, fontSize: 14, fontWeight: 700 }}>Lead brief</span>
        {score > 0 && <span style={{ color: colors.amber, fontSize: 13, fontWeight: 700 }}>ICP fit {score}/100</span>}
        {intel.confidence && <span style={s.badge(CONFIDENCE_COLOR[intel.confidence] ?? colors.textFaint)}>{intel.confidence} confidence</span>}
      </div>

      {(lead.aiSummary || facts.length > 0) && (
        <div style={{ marginBottom: 14 }}>
          {lead.aiSummary && <div style={{ color: '#cbd5e1', fontSize: 13, lineHeight: 1.7 }}>{lead.aiSummary}</div>}
          {facts.length > 0 && (
            <div style={{ color: colors.textMuted, fontSize: 12, marginTop: 6 }}>
              {facts.join(' · ').replace(/^./, (c) => c.toUpperCase())}.
            </div>
          )}
        </div>
      )}

      {reasons.length > 0 && (
        <BriefSection title="Why they fit">
          <ul style={briefList}>
            {reasons.map((r, i) => (
              <li key={i}>
                {r.sourceUrl
                  ? <a href={r.sourceUrl} target="_blank" rel="noreferrer" style={{ color: colors.blueLight }}>{r.text}</a>
                  : r.text}
              </li>
            ))}
          </ul>
        </BriefSection>
      )}

      {lead.outreachAngle && (
        <BriefSection title="Best way in">
          <div style={{ color: '#cbd5e1', fontSize: 13, lineHeight: 1.7 }}>{lead.outreachAngle}</div>
        </BriefSection>
      )}

      {riskFlags.length > 0 && (
        <BriefSection title="Worth knowing before you reach out">
          <ul style={{ ...briefList, color: colors.amber }}>
            {riskFlags.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </BriefSection>
      )}

      {intel.recommendedAction && (
        <div style={{ color: colors.textMuted, fontSize: 13, lineHeight: 1.7 }}>
          <span style={{ color: colors.textFaint }}>Suggested next step — </span>
          {ACTION_NEXT_STEP[intel.recommendedAction] ?? intel.recommendedAction}
        </div>
      )}
    </div>
  )
}

function JobProgressBar({ progress, state }: { progress: number; state: string }) {
  const cfg: Record<string, { color: string; label: string }> = {
    waiting: { color: colors.textFaint, label: 'Queued' },
    active: { color: colors.amber, label: `Processing…` },
    completed: { color: colors.green, label: 'Complete' },
    failed: { color: colors.red, label: 'Failed' }
  }
  const c = cfg[state] ?? cfg.waiting
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ color: c.color, fontSize: 12, fontWeight: 600 }}>{c.label}</span>
        {state === 'active' && <span style={{ color: colors.textFaint, fontSize: 11 }}>{progress}%</span>}
      </div>
      {state === 'active' && (
        <div style={{ background: '#1e2d40', borderRadius: 3, height: 3, overflow: 'hidden' }}>
          <div style={{ width: `${progress}%`, height: '100%', background: colors.amber, borderRadius: 3, transition: 'width 0.4s' }} />
        </div>
      )}
    </div>
  )
}

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')

function LeadDetailPanel({ lead, api, toast, onUpdate, onClose, campaigns }: {
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

export function Leads({ api, workspace, toast, canManage = false }: Props) {
  const route = useMemo(() => makeRouteApi(api), [api])
  const [leads, setLeads] = useState<Lead[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [stageFilter, setStageFilter] = useState('')
  const [skippedOnly, setSkippedOnly] = useState(false)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Lead | null>(null)
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState(BLANK_FORM)
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [importing, setImporting] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkWorking, setBulkWorking] = useState<string | null>(null)
  const [showBulkMenu, setShowBulkMenu] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const LIMIT = 25

  // Monotonic request id: fetchLeads runs both from the effect (workspace/filter/
  // page changes) and imperatively (after add/delete/bulk). Only the most recent
  // call may apply its result, so a slow earlier response can't clobber a newer
  // one (e.g. fast filter typing or a workspace switch).
  const leadsReqRef = useRef(0)
  const fetchLeads = useCallback(() => {
    if (!workspace) return
    const reqId = ++leadsReqRef.current
    setLoading(true)
    const params = new URLSearchParams({ workspaceId: workspace.id, page: String(page), limit: String(LIMIT) })
    if (stageFilter) params.set('stage', stageFilter)
    if (skippedOnly) params.set('skipped', 'true')
    if (search.trim()) params.set('search', search.trim())
    api<{ leads: Lead[]; total: number }>(`/api/leads?${params}`)
      .then(d => { if (reqId === leadsReqRef.current) { setLeads(d.leads || []); setTotal(d.total || 0) } })
      .catch(e => { if (reqId === leadsReqRef.current) toast.error(e.message) })
      .finally(() => { if (reqId === leadsReqRef.current) setLoading(false) })
  }, [workspace?.id, page, stageFilter, skippedOnly, search])

  useEffect(() => { fetchLeads() }, [fetchLeads])

  useEffect(() => {
    if (!workspace) return
    let cancelled = false
    api<{ campaigns: Campaign[] }>(`/api/campaigns?workspaceId=${workspace.id}`)
      .then(d => { if (!cancelled) setCampaigns(d.campaigns || []) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [workspace?.id])

  async function addLead() {
    if (!form.businessName.trim() || !workspace) return
    setSaving(true)
    try {
      const body: CreateLeadRequest = { ...form, workspaceId: workspace.id }
      const d = await route('POST /api/leads', { body }) as { lead: Lead }
      setLeads(prev => [d.lead, ...prev])
      setTotal(t => t + 1)
      setForm(BLANK_FORM)
      setAdding(false)
      toast.success(`Lead added — score ${d.lead.score}`)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to add lead') }
    finally { setSaving(false) }
  }

  async function deleteLead(leadId: string) {
    if (!confirm('Delete this lead?')) return
    try {
      await route('DELETE /api/leads/:id', { params: { id: leadId } })
      setLeads(prev => prev.filter(l => l.id !== leadId))
      setTotal(t => t - 1)
      if (selected?.id === leadId) setSelected(null)
      toast.success('Lead deleted')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Delete failed') }
  }

  async function importCsv(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !workspace) return
    setImporting(true)
    try {
      const text = await file.text()
      const rows = parseCsv(text)
      if (rows.length === 0) { toast.error('No valid rows found in CSV'); return }

      // Shape mapped CSV rows to the shared LeadInput contract (the API ignores
      // any field not listed there, e.g. phone — so we don't send it).
      const leads: LeadInput[] = rows.map(r => ({
        businessName: r.businessName || r.business_name || r.Business || r['Business Name'] || '',
        contactName: r.contactName || r.contact_name || r.Contact || '',
        email: r.email || r.Email || '',
        website: r.website || r.Website || '',
        city: r.city || r.City || '',
        category: r.category || r.Category || '',
        notes: r.notes || r.Notes || ''
      })).filter(l => l.businessName.trim())

      if (leads.length === 0) { toast.error('No rows with a businessName found. Check your CSV column headers.'); return }

      const body: ImportLeadsRequest = { workspaceId: workspace.id, leads }
      const d = await route('POST /api/leads/import', { body })
      toast.success(`Imported ${d.created} leads with auto-scoring`)
      fetchLeads()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Import failed') }
    finally { setImporting(false); if (fileRef.current) fileRef.current.value = '' }
  }

  async function bulkResearch() {
    if (!workspace || selectedIds.size === 0) return
    setBulkWorking('research')
    try {
      let count = 0
      for (const id of selectedIds) {
        try {
          await route('POST /api/jobs/:type', { params: { type: 'research' }, body: { leadId: id } })
          count++
        } catch { /* skip leads that fail — might hit usage limit */ }
      }
      toast.success(`Queued AI research for ${count} leads`)
      setSelectedIds(new Set())
      setShowBulkMenu(false)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Bulk queue failed') }
    finally { setBulkWorking(null) }
  }

  async function bulkDelete() {
    if (!workspace || selectedIds.size === 0) return
    if (!confirm(`Delete ${selectedIds.size} leads? This cannot be undone.`)) return
    setBulkWorking('delete')
    try {
      const d = await route('POST /api/leads/bulk-delete', { body: { workspaceId: workspace.id, ids: [...selectedIds] } })
      toast.success(`Deleted ${d.deleted} leads`)
      setSelectedIds(new Set())
      setShowBulkMenu(false)
      fetchLeads()
      if (selected && selectedIds.has(selected.id)) setSelected(null)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Bulk delete failed') }
    finally { setBulkWorking(null) }
  }

  async function bulkStage(stage: string) {
    if (!workspace || selectedIds.size === 0) return
    setBulkWorking('stage')
    try {
      const d = await route('POST /api/leads/bulk-stage', { body: { workspaceId: workspace.id, ids: [...selectedIds], stage } })
      toast.success(`Moved ${d.updated} leads to ${stage}`)
      setSelectedIds(new Set())
      setShowBulkMenu(false)
      fetchLeads()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Bulk stage update failed') }
    finally { setBulkWorking(null) }
  }

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const allSelected = leads.length > 0 && leads.every(l => selectedIds.has(l.id))
  const ff = (field: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [field]: e.target.value }))

  return (
    <div style={s.stack}>
      {/* Controls bar */}
      <div style={{ ...s.card, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <select style={{ ...s.input, width: 160 }} value={stageFilter} onChange={e => { setStageFilter(e.target.value); setPage(1) }}>
          <option value="">All stages</option>
          {STAGES.map(st => <option key={st} value={st}>{st}</option>)}
        </select>

        <input
          style={{ ...s.input, width: 200 }}
          placeholder="Search leads…"
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1) }}
        />

        <button
          style={{ ...s.btnSm, background: skippedOnly ? colors.amber : '#1f2937', color: skippedOnly ? '#000' : colors.textMuted, fontWeight: skippedOnly ? 700 : 400 }}
          title="Show only poor-fit leads the outreach gate skipped"
          onClick={() => { setSkippedOnly(v => !v); setPage(1) }}
        >
          ⏭ Skipped
        </button>

        <span style={{ color: colors.textFaint, fontSize: 13 }}>{total} leads</span>

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          {canManage && selectedIds.size > 0 && (
            <div style={{ position: 'relative' }}>
              <button
                style={{ ...s.btnSm, background: '#1e3a5f', color: colors.blueLight }}
                onClick={() => setShowBulkMenu(v => !v)}
                disabled={!!bulkWorking}
              >
                {bulkWorking ? <><Spinner size={12} /> Working…</> : `⚡ ${selectedIds.size} selected ▾`}
              </button>
              {showBulkMenu && (
                <div style={{
                  position: 'absolute', top: '100%', right: 0, marginTop: 4,
                  background: colors.bgElevated, border: `1px solid ${colors.border}`,
                  borderRadius: 8, padding: 8, zIndex: 100, minWidth: 180,
                  display: 'grid', gap: 2
                }}>
                  <button style={{ ...s.btnSm, textAlign: 'left' }} onClick={bulkResearch}>
                    ✦ Queue AI Research
                  </button>
                  <div style={{ borderTop: `1px solid ${colors.borderLight}`, margin: '4px 0' }} />
                  <div style={{ color: colors.textFaint, fontSize: 11, padding: '4px 8px' }}>Move to stage</div>
                  {['OUTREACH_SENT', 'REPLIED', 'BOOKED', 'CLOSED', 'DEAD'].map(st => (
                    <button key={st} style={{ ...s.btnSm, textAlign: 'left', fontSize: 12 }} onClick={() => bulkStage(st)}>
                      → {st}
                    </button>
                  ))}
                  <div style={{ borderTop: `1px solid ${colors.borderLight}`, margin: '4px 0' }} />
                  <button style={{ ...s.btnSm, textAlign: 'left', color: colors.red }} onClick={bulkDelete}>
                    ✕ Delete selected
                  </button>
                </div>
              )}
            </div>
          )}
          {canManage && (
            <button style={s.btnSm} onClick={() => fileRef.current?.click()} disabled={importing}>
              {importing ? <><Spinner size={12} /> Importing…</> : '↑ Import CSV'}
            </button>
          )}
          <input ref={fileRef} type="file" accept=".csv" style={{ display: 'none' }} onChange={importCsv} />
          {canManage && workspace && (
            <button style={s.btnSm} onClick={() => {
              const url = `${API_BASE}/api/leads/export?workspaceId=${workspace.id}`
              const link = document.createElement('a')
              link.href = url
              link.setAttribute('download', `leads-${new Date().toISOString().slice(0, 10)}.csv`)
              document.body.appendChild(link)
              link.click()
              document.body.removeChild(link)
            }}>
              ↓ Export CSV
            </button>
          )}
          {canManage && <button style={s.btn} onClick={() => setAdding(v => !v)}>+ Add Lead</button>}
        </div>
      </div>

      {/* Add form */}
      {adding && (
        <div style={s.card}>
          <div style={s.sectionHeader}>New Lead</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 16 }}>
            {[
              { label: 'Business Name *', field: 'businessName' },
              { label: 'Contact Name', field: 'contactName' },
              { label: 'Email', field: 'email' },
              { label: 'Phone', field: 'phone' },
              { label: 'Website', field: 'website' },
              { label: 'City', field: 'city' },
              { label: 'Category', field: 'category' }
            ].map(({ label, field }) => (
              <div key={field}>
                <label style={s.label} htmlFor="leads-field-3">{label}</label>
                <input id="leads-field-3" style={s.input} value={(form as Record<string, string>)[field]} onChange={ff(field)} />
              </div>
            ))}
            <div style={{ gridColumn: '1/-1' }}>
              <label style={s.label} htmlFor="leads-field-4">Notes</label>
              <textarea id="leads-field-4" style={{ ...s.textarea, height: 60 }} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button style={s.btn} disabled={saving} onClick={addLead}>{saving ? 'Saving…' : 'Save Lead'}</button>
            <button style={{ ...s.btn, background: '#1f2937' }} onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </div>
      )}

      {/* Table */}
      <div style={s.card} onClick={() => setShowBulkMenu(false)}>
        {loading && leads.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 32 }}><Spinner /></div>
        ) : leads.length === 0 ? (
          <EmptyState message="No leads found. Add your first lead or import a CSV." icon="◎" />
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${colors.borderLight}` }}>
                <th style={{ width: 32, padding: '8px 12px' }}>
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={e => setSelectedIds(e.target.checked ? new Set(leads.map(l => l.id)) : new Set())}
                  />
                </th>
                {['Business', 'Contact', 'Email', 'Category', 'Stage', 'Score', ''].map(h => (
                  <th key={h} style={{ padding: '8px 12px', color: colors.textFaint, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', textAlign: 'left' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {leads.map(lead => (
                <tr
                  key={lead.id}
                  style={{ borderBottom: `1px solid ${colors.borderLight}`, cursor: 'pointer', background: selected?.id === lead.id ? '#0f172a' : 'transparent' }}
                  onClick={() => setSelected(selected?.id === lead.id ? null : lead)}
                >
                  <td style={{ padding: '10px 12px' }} onClick={e => e.stopPropagation()}>
                    <input type="checkbox" checked={selectedIds.has(lead.id)} onChange={() => toggleSelect(lead.id)} />
                  </td>
                  <td style={{ padding: '10px 12px', color: colors.text, fontSize: 14, fontWeight: 500 }}>
                    {lead.businessName}
                    {lead.outreachSkippedAt && <span style={{ ...s.badge(colors.amber), marginLeft: 6 }} title="Outreach skipped — poor fit">skipped</span>}
                  </td>
                  <td style={{ padding: '10px 12px', color: colors.textMuted, fontSize: 13 }}>{lead.contactName || '–'}</td>
                  <td style={{ padding: '10px 12px', color: colors.textMuted, fontSize: 13 }}>{lead.email || '–'}</td>
                  <td style={{ padding: '10px 12px', color: colors.textFaint, fontSize: 12 }}>{lead.category || '–'}</td>
                  <td style={{ padding: '10px 12px' }}>
                    <span style={s.badge(STAGE_COLOR[lead.stage] || colors.textFaint)}>{lead.stage}</span>
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    <ScorePill score={lead.score} />
                  </td>
                  <td style={{ padding: '10px 12px' }} onClick={e => e.stopPropagation()}>
                    {canManage && <button style={s.btnDanger} aria-label={`Delete lead ${lead.businessName}`} onClick={() => deleteLead(lead.id)}>✕</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {total > LIMIT && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 16 }}>
            <button style={s.btnSm} disabled={page === 1} onClick={() => setPage(p => p - 1)}>← Prev</button>
            <span style={{ color: colors.textFaint, fontSize: 13 }}>Page {page} of {Math.ceil(total / LIMIT)}</span>
            <button style={s.btnSm} disabled={leads.length < LIMIT} onClick={() => setPage(p => p + 1)}>Next →</button>
          </div>
        )}
      </div>

      {/* Detail panel */}
      {selected && (
        <LeadDetailPanel
          lead={selected}
          api={api}
          toast={toast}
          campaigns={campaigns}
          onUpdate={updated => {
            setLeads(prev => prev.map(l => l.id === updated.id ? updated : l))
            setSelected(updated)
          }}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}
