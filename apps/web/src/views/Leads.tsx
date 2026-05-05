import React, { useEffect, useState, useCallback, useRef } from 'react'
import type { Lead, Workspace, Campaign, OutreachDraft } from '../types.js'
import { STAGES, STAGE_COLOR } from '../types.js'
import { s, colors } from '../styles.js'
import { Spinner, EmptyState } from '../components/Spinner.js'
import type { ApiHook } from '../hooks/useApi.js'
import type { ToastHook } from '../hooks/useToast.js'

type Props = { api: ApiHook; workspace: Workspace | null; toast: ToastHook }

const BLANK_FORM = { businessName: '', contactName: '', email: '', phone: '', website: '', city: '', category: '', notes: '', score: '' }

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/)
  if (lines.length < 2) return []
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''))
  return lines.slice(1).map(line => {
    const vals = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''))
    const row: Record<string, string> = {}
    headers.forEach((h, i) => { row[h] = vals[i] || '' })
    return row
  })
}

function LeadDetailPanel({ lead, api, toast, onUpdate, onClose }: {
  lead: Lead; api: ApiHook; toast: ToastHook
  onUpdate: (l: Lead) => void; onClose: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState({ ...lead })
  const [drafts, setDrafts] = useState<OutreachDraft[]>([])
  const [queueing, setQueueing] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api<{ drafts: OutreachDraft[] }>(`/api/leads/${lead.id}/drafts`).then(d => setDrafts(d.drafts)).catch(() => {})
  }, [lead.id])

  async function save() {
    setSaving(true)
    try {
      const d = await api<{ lead: Lead }>(`/api/leads/${lead.id}`, {
        method: 'PATCH',
        body: JSON.stringify(form)
      })
      onUpdate(d.lead)
      setEditing(false)
      toast.success('Lead updated')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Update failed') }
    finally { setSaving(false) }
  }

  async function enqueue(type: 'research' | 'outreach') {
    setQueueing(type)
    try {
      await api(`/api/jobs/${type}`, { method: 'POST', body: JSON.stringify({ leadId: lead.id }) })
      toast.success(`${type === 'research' ? 'Research' : 'Outreach generation'} queued — results will appear shortly`)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to queue job') }
    finally { setQueueing(null) }
  }

  async function moveStage(stage: string) {
    try {
      const d = await api<{ lead: Lead }>(`/api/leads/${lead.id}`, { method: 'PATCH', body: JSON.stringify({ stage }) })
      onUpdate(d.lead)
      toast.success(`Moved to ${stage}`)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Update failed') }
  }

  const ff = (field: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [field]: e.target.value }))

  return (
    <div style={{ ...s.card, borderColor: colors.blue + '44' }}>
      <div style={{ ...s.flexBetween, marginBottom: 20 }}>
        <h3 style={{ color: colors.text, margin: 0, fontSize: 16 }}>{lead.businessName}</h3>
        <div style={{ display: 'flex', gap: 8 }}>
          <button style={s.btnSm} onClick={() => setEditing(v => !v)}>{editing ? 'Cancel' : 'Edit'}</button>
          <button style={s.btnSm} onClick={onClose}>✕</button>
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
            { label: 'Category', field: 'category' },
            { label: 'Score', field: 'score' }
          ].map(({ label, field }) => (
            <div key={field}>
              <label style={s.label}>{label}</label>
              <input style={s.input} value={(form as Record<string, string | number>)[field] as string ?? ''} onChange={ff(field)} />
            </div>
          ))}
          <div style={{ gridColumn: '1/-1' }}>
            <label style={s.label}>Notes</label>
            <textarea style={{ ...s.textarea, height: 80 }} value={form.notes ?? ''} onChange={ff('notes')} />
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
            { label: 'Score', value: lead.score > 0 ? String(lead.score) : null }
          ].filter(x => x.value).map(({ label, value }) => (
            <div key={label}>
              <span style={{ color: colors.textFaint, fontSize: 12 }}>{label}: </span>
              <span style={{ color: colors.text, fontSize: 14 }}>{value}</span>
            </div>
          ))}
        </div>
      )}

      {/* AI fields */}
      {(lead.aiSummary || lead.outreachAngle) && (
        <div style={{ display: 'grid', gap: 10, marginBottom: 16 }}>
          {lead.aiSummary && (
            <div style={s.cardInner}>
              <div style={{ color: colors.textFaint, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>AI Summary</div>
              <div style={{ color: '#cbd5e1', fontSize: 13, lineHeight: 1.5 }}>{lead.aiSummary}</div>
            </div>
          )}
          {lead.outreachAngle && (
            <div style={s.cardInner}>
              <div style={{ color: colors.textFaint, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Outreach Angle</div>
              <div style={{ color: '#cbd5e1', fontSize: 13, lineHeight: 1.5 }}>{lead.outreachAngle}</div>
            </div>
          )}
        </div>
      )}

      {/* Outreach drafts */}
      {drafts.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={s.sectionHeader}>Outreach Drafts</div>
          {drafts.map(d => (
            <div key={d.id} style={{ ...s.cardInner, marginBottom: 8 }}>
              <div style={{ color: colors.text, fontWeight: 600, marginBottom: 4, fontSize: 13 }}>{d.subject}</div>
              <div style={{ color: colors.textMuted, fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{d.emailBody}</div>
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

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        <button
          style={{ ...s.btnSm, background: '#1e3a5f' }}
          disabled={queueing === 'research'}
          onClick={() => enqueue('research')}
        >
          {queueing === 'research' ? <><Spinner size={12} /> Queuing…</> : '✦ Research'}
        </button>
        <button
          style={{ ...s.btnSm, background: '#2d1d5e' }}
          disabled={queueing === 'outreach'}
          onClick={() => enqueue('outreach')}
        >
          {queueing === 'outreach' ? <><Spinner size={12} /> Queuing…</> : '✉ Generate Outreach'}
        </button>
      </div>

      {/* Stage selector */}
      <div>
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

export function Leads({ api, workspace, toast }: Props) {
  const [leads, setLeads] = useState<Lead[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [stageFilter, setStageFilter] = useState('')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Lead | null>(null)
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState(BLANK_FORM)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [importing, setImporting] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkQueuing, setBulkQueuing] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const LIMIT = 25

  const fetchLeads = useCallback(() => {
    if (!workspace) return
    setLoading(true)
    const params = new URLSearchParams({ workspaceId: workspace.id, page: String(page), limit: String(LIMIT) })
    if (stageFilter) params.set('stage', stageFilter)
    if (search.trim()) params.set('search', search.trim())
    api<{ leads: Lead[]; total: number }>(`/api/leads?${params}`)
      .then(d => { setLeads(d.leads || []); setTotal(d.total || 0) })
      .catch(e => toast.error(e.message))
      .finally(() => setLoading(false))
  }, [workspace?.id, page, stageFilter, search])

  useEffect(() => { fetchLeads() }, [fetchLeads])

  async function addLead() {
    if (!form.businessName.trim() || !workspace) return
    setSaving(true)
    try {
      const d = await api<{ lead: Lead }>('/api/leads', {
        method: 'POST',
        body: JSON.stringify({ ...form, workspaceId: workspace.id, score: Number(form.score) || 0 })
      })
      setLeads(prev => [d.lead, ...prev])
      setTotal(t => t + 1)
      setForm(BLANK_FORM)
      setAdding(false)
      toast.success('Lead added')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to add lead') }
    finally { setSaving(false) }
  }

  async function deleteLead(leadId: string) {
    if (!confirm('Delete this lead?')) return
    try {
      await api(`/api/leads/${leadId}`, { method: 'DELETE' })
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

      const leads = rows.map(r => ({
        businessName: r.businessName || r.business_name || r.Business || r['Business Name'] || '',
        contactName: r.contactName || r.contact_name || r.Contact || '',
        email: r.email || r.Email || '',
        phone: r.phone || r.Phone || '',
        website: r.website || r.Website || '',
        city: r.city || r.City || '',
        category: r.category || r.Category || '',
        notes: r.notes || r.Notes || '',
        score: Number(r.score || r.Score || 0)
      })).filter(l => l.businessName.trim())

      if (leads.length === 0) { toast.error('No rows with a businessName found. Check your CSV column headers.'); return }

      const d = await api<{ created: number }>('/api/leads/import', {
        method: 'POST',
        body: JSON.stringify({ workspaceId: workspace.id, leads })
      })
      toast.success(`Imported ${d.created} leads`)
      fetchLeads()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Import failed') }
    finally { setImporting(false); if (fileRef.current) fileRef.current.value = '' }
  }

  async function bulkResearch() {
    if (!workspace || selectedIds.size === 0) return
    setBulkQueuing(true)
    try {
      let count = 0
      for (const id of selectedIds) {
        await api(`/api/jobs/research`, { method: 'POST', body: JSON.stringify({ leadId: id }) })
        count++
      }
      toast.success(`Queued AI research for ${count} leads`)
      setSelectedIds(new Set())
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Bulk queue failed') }
    finally { setBulkQueuing(false) }
  }

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

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

        <span style={{ color: colors.textFaint, fontSize: 13 }}>{total} leads</span>

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          {selectedIds.size > 0 && (
            <button
              style={{ ...s.btnSm, background: '#1e3a5f', color: colors.blueLight }}
              onClick={bulkResearch}
              disabled={bulkQueuing}
            >
              {bulkQueuing ? <><Spinner size={12} /> Queuing…</> : `✦ Research ${selectedIds.size} selected`}
            </button>
          )}
          <button style={s.btnSm} onClick={() => fileRef.current?.click()} disabled={importing}>
            {importing ? <><Spinner size={12} /> Importing…</> : '↑ Import CSV'}
          </button>
          <input ref={fileRef} type="file" accept=".csv" style={{ display: 'none' }} onChange={importCsv} />
          <button style={s.btn} onClick={() => setAdding(v => !v)}>+ Add Lead</button>
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
              { label: 'Category', field: 'category' },
              { label: 'Score (0-100)', field: 'score' }
            ].map(({ label, field }) => (
              <div key={field}>
                <label style={s.label}>{label}</label>
                <input style={s.input} value={(form as Record<string, string>)[field]} onChange={ff(field)} />
              </div>
            ))}
            <div style={{ gridColumn: '1/-1' }}>
              <label style={s.label}>Notes</label>
              <textarea style={{ ...s.textarea, height: 60 }} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button style={s.btn} disabled={saving} onClick={addLead}>{saving ? 'Saving…' : 'Save Lead'}</button>
            <button style={{ ...s.btn, background: '#1f2937' }} onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </div>
      )}

      {/* Table */}
      <div style={s.card}>
        {loading && leads.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 32 }}><Spinner /></div>
        ) : leads.length === 0 ? (
          <EmptyState message="No leads found. Add your first lead or import a CSV." icon="◎" />
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${colors.borderLight}` }}>
                <th style={{ width: 32, padding: '8px 12px' }}>
                  <input type="checkbox" onChange={e => setSelectedIds(e.target.checked ? new Set(leads.map(l => l.id)) : new Set())} />
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
                  <td style={{ padding: '10px 12px', color: colors.text, fontSize: 14, fontWeight: 500 }}>{lead.businessName}</td>
                  <td style={{ padding: '10px 12px', color: colors.textMuted, fontSize: 13 }}>{lead.contactName || '–'}</td>
                  <td style={{ padding: '10px 12px', color: colors.textMuted, fontSize: 13 }}>{lead.email || '–'}</td>
                  <td style={{ padding: '10px 12px', color: colors.textFaint, fontSize: 12 }}>{lead.category || '–'}</td>
                  <td style={{ padding: '10px 12px' }}>
                    <span style={s.badge(STAGE_COLOR[lead.stage] || colors.textFaint)}>{lead.stage}</span>
                  </td>
                  <td style={{ padding: '10px 12px', color: lead.score > 0 ? colors.amber : colors.textFaint, fontSize: 13, fontWeight: lead.score > 0 ? 700 : 400 }}>
                    {lead.score || '–'}
                  </td>
                  <td style={{ padding: '10px 12px' }} onClick={e => e.stopPropagation()}>
                    <button style={s.btnDanger} onClick={() => deleteLead(lead.id)}>✕</button>
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
