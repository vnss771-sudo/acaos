import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import type { CreateLeadRequest, ImportLeadsRequest, LeadInput } from '@acaos/shared'
import type { Lead, Workspace, Campaign } from '../types.js'
import { s, colors } from '../styles.js'
import { ErrorBanner } from '../components/ui/ErrorBanner.js'
import { Modal } from '../components/ui/Modal.js'
import type { SortState } from '../components/ui/Table.js'
import { makeRouteApi } from '../lib/routeApi.js'
import { parseCsv } from '../lib/csv.js'
import type { ApiHook } from '../hooks/useApi.js'
import type { ToastHook } from '../hooks/useToast.js'
import { LeadDetailPanel } from '../components/leads/LeadDetailPanel.js'
import { LeadsToolbar } from '../components/leads/LeadsToolbar.js'
import { AddLeadForm, type NewLeadForm } from '../components/leads/AddLeadForm.js'
import { LeadsTable } from '../components/leads/LeadsTable.js'

type Props = { api: ApiHook; workspace: Workspace | null; toast: ToastHook; canManage?: boolean }

const BLANK_FORM: NewLeadForm = {
  businessName: '', contactName: '', email: '', phone: '',
  website: '', city: '', category: '', notes: '', score: ''
}

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')

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
  const [loadError, setLoadError] = useState(false)
  const [saving, setSaving] = useState(false)
  const [importing, setImporting] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkWorking, setBulkWorking] = useState<string | null>(null)
  const [showBulkMenu, setShowBulkMenu] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Lead | null>(null)
  const [bulkDeleteConfirmOpen, setBulkDeleteConfirmOpen] = useState(false)
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
    setLoadError(false)
    const params = new URLSearchParams({ workspaceId: workspace.id, page: String(page), limit: String(LIMIT) })
    if (stageFilter) params.set('stage', stageFilter)
    if (skippedOnly) params.set('skipped', 'true')
    if (search.trim()) params.set('search', search.trim())
    api<{ leads: Lead[]; total: number }>(`/api/leads?${params}`)
      .then(d => { if (reqId === leadsReqRef.current) { setLeads(d.leads || []); setTotal(d.total || 0) } })
      .catch(e => {
        if (reqId !== leadsReqRef.current) return
        toast.error(e.message)
        setLoadError(true)
      })
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
    try {
      await route('DELETE /api/leads/:id', { params: { id: leadId } })
      setLeads(prev => prev.filter(l => l.id !== leadId))
      setTotal(t => t - 1)
      if (selected?.id === leadId) setSelected(null)
      toast.success('Lead deleted')
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Delete failed') }
    finally { setDeleteTarget(null) }
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
      // Optional consent evidence: a "consent date" column is the common shape
      // (an opt-in export) and implies express consent unless a basis column
      // says otherwise — the API records a ConsentRecord alongside the lead
      // when it recognizes the basis (see CONSENT_BASES in the compliance API).
      const leads: LeadInput[] = rows.map(r => {
        const consentAt = r.consentAt || r.consent_at || r['Consent Date'] || r.consentDate || r['Opt-in Date'] || r.optInAt || ''
        const consentBasisRaw = r.consentBasis || r.consent_basis || r['Consent Basis'] || ''
        const consentBasis = ['express_consent', 'implied_consent', 'legitimate_interest'].includes(consentBasisRaw)
          ? consentBasisRaw
          : (consentAt ? 'express_consent' : '')
        return {
          businessName: r.businessName || r.business_name || r.Business || r['Business Name'] || '',
          contactName: r.contactName || r.contact_name || r.Contact || '',
          email: r.email || r.Email || '',
          website: r.website || r.Website || '',
          city: r.city || r.City || '',
          category: r.category || r.Category || '',
          notes: r.notes || r.Notes || '',
          ...(consentBasis ? { consentBasis, consentAt: consentAt || undefined } : {}),
        }
      }).filter(l => l.businessName.trim())

      if (leads.length === 0) { toast.error('No rows with a businessName found. Check your CSV column headers.'); return }

      const body: ImportLeadsRequest = { workspaceId: workspace.id, leads }
      const d = await route('POST /api/leads/import', { body })
      const consentNote = d.consentRecorded > 0 ? ` (${d.consentRecorded} with consent recorded)` : ''
      toast.success(`Imported ${d.created} leads with auto-scoring${consentNote}`)
      fetchLeads()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Import failed') }
    finally { setImporting(false); if (fileRef.current) fileRef.current.value = '' }
  }

  function exportCsv() {
    if (!workspace) return
    const url = `${API_BASE}/api/leads/export?workspaceId=${workspace.id}`
    const link = document.createElement('a')
    link.href = url
    link.setAttribute('download', `leads-${new Date().toISOString().slice(0, 10)}.csv`)
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
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
    setBulkWorking('delete')
    try {
      const d = await route('POST /api/leads/bulk-delete', { body: { workspaceId: workspace.id, ids: [...selectedIds] } })
      toast.success(`Deleted ${d.deleted} leads`)
      setSelectedIds(new Set())
      setShowBulkMenu(false)
      fetchLeads()
      if (selected && selectedIds.has(selected.id)) setSelected(null)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Bulk delete failed') }
    finally { setBulkWorking(null); setBulkDeleteConfirmOpen(false) }
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

  // Client-side sort of the loaded page — same approach as Prospects.tsx. Default
  // (no sort) preserves server order; sorting only reorders the current page since
  // pagination itself stays server-side.
  const [sort, setSort] = useState<SortState | undefined>()
  const sortedLeads = useMemo(() => {
    if (!sort) return leads
    const dir = sort.dir === 'asc' ? 1 : -1
    const val = (l: Lead): string | number => {
      switch (sort.key) {
        case 'businessName': return (l.businessName ?? '').toLowerCase()
        case 'contactName': return (l.contactName ?? '').toLowerCase()
        case 'email': return (l.email ?? '').toLowerCase()
        case 'category': return (l.category ?? '').toLowerCase()
        case 'stage': return l.stage ?? ''
        case 'score': return l.score ?? 0
        default: return ''
      }
    }
    return [...leads].sort((a, b) => {
      const av = val(a), bv = val(b)
      return av < bv ? -dir : av > bv ? dir : 0
    })
  }, [leads, sort])

  const toggleAllLeads = () => setSelectedIds(allSelected ? new Set() : new Set(leads.map(l => l.id)))

  return (
    <div style={s.stack}>
      {loadError && <ErrorBanner message="Failed to load leads." onRetry={fetchLeads} />}

      <div style={{ color: colors.textFaint, fontSize: 12 }}>
        Leads are outreach-ready contacts — score, research, draft, and send campaigns here.
        Looking for new opportunities to qualify first? That's the <strong style={{ color: colors.textMuted }}>Prospects</strong> page.
      </div>

      <LeadsToolbar
        stageFilter={stageFilter}
        onStageFilterChange={v => { setStageFilter(v); setPage(1) }}
        search={search}
        onSearchChange={v => { setSearch(v); setPage(1) }}
        skippedOnly={skippedOnly}
        onToggleSkipped={() => { setSkippedOnly(v => !v); setPage(1) }}
        total={total}
        canManage={canManage}
        selectedCount={selectedIds.size}
        bulkWorking={bulkWorking}
        showBulkMenu={showBulkMenu}
        onToggleBulkMenu={() => setShowBulkMenu(v => !v)}
        onBulkResearch={bulkResearch}
        onBulkDeleteRequest={() => setBulkDeleteConfirmOpen(true)}
        onBulkStage={bulkStage}
        importing={importing}
        fileRef={fileRef}
        onImportClick={() => fileRef.current?.click()}
        onImportCsv={importCsv}
        hasWorkspace={!!workspace}
        onExportCsv={exportCsv}
        onAddClick={() => setAdding(v => !v)}
      />

      {adding && (
        <AddLeadForm
          form={form}
          setForm={setForm}
          saving={saving}
          onSave={addLead}
          onCancel={() => setAdding(false)}
        />
      )}

      <LeadsTable
        leads={leads}
        sortedLeads={sortedLeads}
        loading={loading}
        canManage={canManage}
        onRowClick={l => setSelected(selected?.id === l.id ? null : l)}
        sort={sort}
        onSortChange={setSort}
        selectedIds={selectedIds}
        onToggleRow={toggleSelect}
        onToggleAll={toggleAllLeads}
        onDeleteRequest={setDeleteTarget}
        onAddClick={() => setAdding(true)}
        onDismissMenu={() => setShowBulkMenu(false)}
        total={total}
        page={page}
        onPageChange={setPage}
        limit={LIMIT}
      />

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

      <Modal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="Delete lead?"
        footer={<>
          <button style={s.btnSecondary} onClick={() => setDeleteTarget(null)}>Cancel</button>
          <button style={s.btnDanger} onClick={() => deleteTarget && deleteLead(deleteTarget.id)}>Delete</button>
        </>}
      >
        <div style={{ color: colors.textMuted, fontSize: 14 }}>
          Delete {deleteTarget?.businessName}? This cannot be undone.
        </div>
      </Modal>

      <Modal
        open={bulkDeleteConfirmOpen}
        onClose={() => setBulkDeleteConfirmOpen(false)}
        title="Delete selected leads?"
        footer={<>
          <button style={s.btnSecondary} onClick={() => setBulkDeleteConfirmOpen(false)}>Cancel</button>
          <button style={s.btnDanger} disabled={bulkWorking === 'delete'} onClick={bulkDelete}>
            {bulkWorking === 'delete' ? 'Deleting…' : 'Delete'}
          </button>
        </>}
      >
        <div style={{ color: colors.textMuted, fontSize: 14 }}>
          Delete {selectedIds.size} lead{selectedIds.size === 1 ? '' : 's'}? This cannot be undone.
        </div>
      </Modal>
    </div>
  )
}
