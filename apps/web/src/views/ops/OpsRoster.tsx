import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { OpsCreateRosterEntryRequest, OpsUpdateRosterEntryRequest, OpsPublishRosterRequest } from '@acaos/shared'
import type { ApiHook } from '../../hooks/useApi.js'
import type { ToastHook } from '../../hooks/useToast.js'
import type { View, Workspace, OpsRosterEntry, OpsCrewMember, OpsJobSite, OpsShiftType } from '../../types.js'
import { colors, s } from '../../styles.js'
import { makeRouteApi } from '../../lib/routeApi.js'
import { Table, type Column } from '../../components/ui/Table.js'
import { EmptyState } from '../../components/ui/EmptyState.js'
import { Skeleton } from '../../components/ui/Skeleton.js'
import { Badge } from '../../components/ui/Badge.js'
import { Modal } from '../../components/ui/Modal.js'
import { Grid } from '../../components/ui/Grid.js'
import { KpiCard } from '../../components/ui/KpiCard.js'
import { Card } from '../../components/ui/Card.js'
import { OpsSubNav } from '../../components/ops/OpsSubNav.js'

type Props = { api: ApiHook; workspace: Workspace | null; toast: ToastHook; canManage?: boolean; setView: (v: View) => void }

type RosterSummary = { draftCount: number; publishedThisWeekCount: number; activeJobSiteCount: number }

const SHIFT_TYPES: OpsShiftType[] = ['REGULAR', 'OVERTIME', 'CALLOUT', 'ON_CALL']

const BLANK_ROSTER_FORM = {
  crewMemberId: '', jobSiteId: '', rosterDate: '', startTime: '', endTime: '',
  shiftType: 'REGULAR' as OpsShiftType, notes: '',
}

type RosterForm = typeof BLANK_ROSTER_FORM

function toIso(dateTimeLocal: string): string {
  return new Date(dateTimeLocal).toISOString()
}

// datetime-local inputs need "YYYY-MM-DDTHH:mm" — convert an ISO timestamp back
// to that shape (in the viewer's local time, matching how it was entered).
function toDatetimeLocal(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formToCreateBody(form: RosterForm, workspaceId: string): OpsCreateRosterEntryRequest {
  return {
    workspaceId,
    crewMemberId: form.crewMemberId,
    jobSiteId: form.jobSiteId,
    rosterDate: toIso(form.rosterDate),
    startTime: toIso(form.startTime),
    endTime: toIso(form.endTime),
    shiftType: form.shiftType,
    ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
  }
}

// The backend's update schema (roster.ts) does not accept crewMemberId — a
// roster entry's crew member can't be changed once created, only its site,
// timing, type and notes. The crew member field is shown read-only on edit.
function formToUpdateBody(form: RosterForm, workspaceId: string): OpsUpdateRosterEntryRequest {
  return {
    workspaceId,
    jobSiteId: form.jobSiteId,
    rosterDate: toIso(form.rosterDate),
    startTime: toIso(form.startTime),
    endTime: toIso(form.endTime),
    shiftType: form.shiftType,
    notes: form.notes.trim() || undefined,
  }
}

// Add/Edit form body shared by both modals.
function RosterFormFields({ form, setForm, isEdit, crewOptions, jobSiteOptions }: {
  form: RosterForm
  setForm: React.Dispatch<React.SetStateAction<RosterForm>>
  isEdit: boolean
  crewOptions: OpsCrewMember[]
  jobSiteOptions: OpsJobSite[]
}) {
  const ff = (field: keyof RosterForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [field]: e.target.value }))

  const selectedCrewName = crewOptions.find(c => c.id === form.crewMemberId)?.fullName

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div>
        <label style={s.label} htmlFor="roster-crew-member">Crew Member</label>
        {isEdit ? (
          <div id="roster-crew-member" style={{ ...s.input, color: colors.textFaint, background: colors.bgCard }}>
            {selectedCrewName ?? '—'}
          </div>
        ) : (
          <select id="roster-crew-member" style={s.input} value={form.crewMemberId} onChange={ff('crewMemberId')} required>
            <option value="">Select crew member…</option>
            {crewOptions.map(c => <option key={c.id} value={c.id}>{c.fullName}</option>)}
          </select>
        )}
      </div>
      <div>
        <label style={s.label} htmlFor="roster-job-site">Job Site</label>
        <select id="roster-job-site" style={s.input} value={form.jobSiteId} onChange={ff('jobSiteId')} required>
          <option value="">Select job site…</option>
          {jobSiteOptions.map(j => <option key={j.id} value={j.id}>{j.siteName}</option>)}
        </select>
      </div>
      <div>
        <label style={s.label} htmlFor="roster-date">Roster Date</label>
        <input id="roster-date" type="datetime-local" style={s.input} value={form.rosterDate} onChange={ff('rosterDate')} required />
      </div>
      <div>
        <label style={s.label} htmlFor="roster-start-time">Start Time</label>
        <input id="roster-start-time" type="datetime-local" style={s.input} value={form.startTime} onChange={ff('startTime')} required />
      </div>
      <div>
        <label style={s.label} htmlFor="roster-end-time">End Time</label>
        <input id="roster-end-time" type="datetime-local" style={s.input} value={form.endTime} onChange={ff('endTime')} required />
      </div>
      <div>
        <label style={s.label} htmlFor="roster-shift-type">Shift Type</label>
        <select id="roster-shift-type" style={s.input} value={form.shiftType} onChange={ff('shiftType')}>
          {SHIFT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      <div>
        <label style={s.label} htmlFor="roster-notes">Notes</label>
        <textarea id="roster-notes" style={{ ...s.textarea, height: 70 }} value={form.notes} onChange={ff('notes')} />
      </div>
    </div>
  )
}

export function OpsRoster({ api, workspace, toast, canManage = false, setView }: Props) {
  const route = useMemo(() => makeRouteApi(api), [api])

  const [summary, setSummary] = useState<RosterSummary | null>(null)

  const [entries, setEntries] = useState<OpsRosterEntry[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)

  const [fromFilter, setFromFilter] = useState('')
  const [toFilter, setToFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')

  const [crewOptions, setCrewOptions] = useState<OpsCrewMember[]>([])
  const [jobSiteOptions, setJobSiteOptions] = useState<OpsJobSite[]>([])

  const [addOpen, setAddOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<OpsRosterEntry | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<OpsRosterEntry | null>(null)
  const [form, setForm] = useState<RosterForm>(BLANK_ROSTER_FORM)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const [publishOpen, setPublishOpen] = useState(false)
  const [publishFrom, setPublishFrom] = useState('')
  const [publishTo, setPublishTo] = useState('')
  const [publishing, setPublishing] = useState(false)

  const LIMIT = 25

  // Monotonic request ids — see Leads.tsx: fetches run both from the effect
  // (filter/page changes) and imperatively (after add/edit/delete/publish), so
  // only the most recent call may apply its result.
  const entriesReqRef = useRef(0)
  const fetchEntries = useCallback(() => {
    if (!workspace) return
    const reqId = ++entriesReqRef.current
    setLoading(true)
    const params = new URLSearchParams({ workspaceId: workspace.id, page: String(page), limit: String(LIMIT) })
    if (fromFilter) params.set('from', new Date(fromFilter).toISOString())
    if (toFilter) params.set('to', new Date(toFilter).toISOString())
    if (statusFilter) params.set('status', statusFilter)
    api<{ entries: OpsRosterEntry[]; total: number }>(`/api/ops/roster?${params}`)
      .then(d => { if (reqId === entriesReqRef.current) { setEntries(d.entries || []); setTotal(d.total || 0) } })
      .catch(e => { if (reqId === entriesReqRef.current) toast.error(e instanceof Error ? e.message : 'Failed to load roster') })
      .finally(() => { if (reqId === entriesReqRef.current) setLoading(false) })
  }, [workspace?.id, page, fromFilter, toFilter, statusFilter])

  useEffect(() => { fetchEntries() }, [fetchEntries])

  const summaryReqRef = useRef(0)
  const fetchSummary = useCallback(() => {
    if (!workspace) return
    const reqId = ++summaryReqRef.current
    api<RosterSummary>(`/api/ops/roster/summary?workspaceId=${workspace.id}`)
      .then(d => { if (reqId === summaryReqRef.current) setSummary(d) })
      .catch(() => {})
  }, [workspace?.id])

  useEffect(() => { fetchSummary() }, [fetchSummary])

  useEffect(() => {
    if (!workspace) return
    let cancelled = false
    api<{ crew: OpsCrewMember[] }>(`/api/ops/crew?workspaceId=${workspace.id}&active=true&limit=100`)
      .then(d => { if (!cancelled) setCrewOptions(d.crew || []) })
      .catch(() => {})
    api<{ jobSites: OpsJobSite[] }>(`/api/ops/jobs?workspaceId=${workspace.id}&status=ACTIVE&limit=100`)
      .then(d => { if (!cancelled) setJobSiteOptions(d.jobSites || []) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [workspace?.id])

  function openAdd() {
    setForm(BLANK_ROSTER_FORM)
    setAddOpen(true)
  }

  function openEdit(entry: OpsRosterEntry) {
    setForm({
      crewMemberId: entry.crewMemberId,
      jobSiteId: entry.jobSiteId,
      rosterDate: toDatetimeLocal(entry.rosterDate),
      startTime: toDatetimeLocal(entry.startTime),
      endTime: toDatetimeLocal(entry.endTime),
      shiftType: entry.shiftType,
      notes: entry.notes ?? '',
    })
    setEditTarget(entry)
  }

  const formValid = !!form.crewMemberId && !!form.jobSiteId && !!form.rosterDate && !!form.startTime && !!form.endTime
  const editFormValid = !!form.jobSiteId && !!form.rosterDate && !!form.startTime && !!form.endTime

  async function submitAdd() {
    if (!workspace || !formValid) return
    setSaving(true)
    try {
      await route('POST /api/ops/roster', { body: formToCreateBody(form, workspace.id) })
      setAddOpen(false)
      setForm(BLANK_ROSTER_FORM)
      toast.success('Roster entry added')
      fetchEntries()
      fetchSummary()
    } catch (e) {
      // The backend returns a clear 409 for a crew member already rostered at
      // that date/start time ("This crew member is already rostered for that
      // date and start time") — surfaced as-is rather than a generic failure.
      toast.error(e instanceof Error ? e.message : 'Failed to add roster entry')
    } finally { setSaving(false) }
  }

  async function submitEdit() {
    if (!workspace || !editTarget || !editFormValid) return
    setSaving(true)
    try {
      await route('PUT /api/ops/roster/:id', { params: { id: editTarget.id }, body: formToUpdateBody(form, workspace.id) })
      setEditTarget(null)
      toast.success('Roster entry updated')
      fetchEntries()
      fetchSummary()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update roster entry')
    } finally { setSaving(false) }
  }

  async function confirmDelete() {
    if (!workspace || !deleteTarget) return
    setDeleting(true)
    try {
      // DELETE takes workspaceId as a query string with no body — never add a
      // `body` here (the raw api() call, not the typed route() client — see
      // routeApi.ts and the RouteContracts note in packages/shared).
      await api(`/api/ops/roster/${deleteTarget.id}?workspaceId=${workspace.id}`, { method: 'DELETE' })
      toast.success('Roster entry removed')
      setDeleteTarget(null)
      fetchEntries()
      fetchSummary()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to remove roster entry')
    } finally { setDeleting(false) }
  }

  function openPublish() {
    const toDateStr = (d: Date) => d.toISOString().slice(0, 10)
    const today = new Date()
    const nextWeek = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000)
    setPublishFrom(fromFilter || toDateStr(today))
    setPublishTo(toFilter || toDateStr(nextWeek))
    setPublishOpen(true)
  }

  async function submitPublish() {
    if (!workspace || !publishFrom || !publishTo) return
    setPublishing(true)
    try {
      const body: OpsPublishRosterRequest = {
        workspaceId: workspace.id,
        from: new Date(publishFrom).toISOString(),
        to: new Date(publishTo).toISOString(),
      }
      const res = await route('POST /api/ops/roster/publish', { body })
      toast.success(`Published ${res.published} roster entr${res.published === 1 ? 'y' : 'ies'}`)
      setPublishOpen(false)
      fetchEntries()
      fetchSummary()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to publish roster')
    } finally { setPublishing(false) }
  }

  const columns: Column<OpsRosterEntry>[] = [
    { key: 'crew', header: 'Crew', render: e => e.crewMember?.fullName ?? '—' },
    { key: 'jobSite', header: 'Job Site', render: e => e.jobSite?.siteName ?? '—' },
    { key: 'date', header: 'Date', render: e => new Date(e.rosterDate).toLocaleDateString() },
    { key: 'time', header: 'Start–End', render: e => `${formatTime(e.startTime)} – ${formatTime(e.endTime)}` },
    { key: 'shiftType', header: 'Type', render: e => <Badge color={colors.blue}>{e.shiftType}</Badge> },
    { key: 'status', header: 'Status', render: e => <Badge color={e.status === 'PUBLISHED' ? colors.green : colors.textFaint}>{e.status}</Badge> },
    ...(canManage ? [{
      key: 'actions', header: '', render: (e: OpsRosterEntry) => (
        e.status === 'DRAFT' ? (
          <div style={{ display: 'flex', gap: 8 }} onClick={ev => ev.stopPropagation()}>
            <button style={s.btnSm} onClick={() => openEdit(e)}>Edit</button>
            <button style={s.btnDanger} onClick={() => setDeleteTarget(e)}>Delete</button>
          </div>
        ) : null
      ),
    } as Column<OpsRosterEntry>] : []),
  ]

  return (
    <div style={s.stack}>
      <OpsSubNav view="ops-roster" setView={setView} />

      {summary ? (
        <Grid cols={3}>
          <KpiCard label="Draft Entries" value={summary.draftCount ?? 0} />
          <KpiCard label="Published This Week" value={summary.publishedThisWeekCount ?? 0} color={colors.green} />
          <KpiCard label="Active Job Sites" value={summary.activeJobSiteCount ?? 0} />
        </Grid>
      ) : (
        <Grid cols={3}>
          {[0, 1, 2].map(i => <Card key={i}><Skeleton height={70} /></Card>)}
        </Grid>
      )}

      <div style={{ ...s.card, display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div>
          <label style={s.label} htmlFor="roster-filter-from">From</label>
          <input id="roster-filter-from" type="date" style={s.input} value={fromFilter} onChange={e => { setFromFilter(e.target.value); setPage(1) }} />
        </div>
        <div>
          <label style={s.label} htmlFor="roster-filter-to">To</label>
          <input id="roster-filter-to" type="date" style={s.input} value={toFilter} onChange={e => { setToFilter(e.target.value); setPage(1) }} />
        </div>
        <div>
          <label style={s.label} htmlFor="roster-filter-status">Status</label>
          <select id="roster-filter-status" style={s.input} value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setPage(1) }}>
            <option value="">All</option>
            <option value="DRAFT">Draft</option>
            <option value="PUBLISHED">Published</option>
          </select>
        </div>
        <span style={{ color: colors.textFaint, fontSize: 13 }}>{total} entr{total === 1 ? 'y' : 'ies'}</span>
        {canManage && (
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button style={s.btnSecondary} onClick={openPublish}>Publish Range</button>
            <button style={s.btn} onClick={openAdd}>+ Add Entry</button>
          </div>
        )}
      </div>

      <div style={s.card}>
        {loading && entries.length === 0 ? (
          <div style={{ display: 'grid', gap: 10 }}>
            {[0, 1, 2, 3].map(i => <Skeleton key={i} height={36} />)}
          </div>
        ) : entries.length === 0 ? (
          <EmptyState
            title="No roster entries"
            description={canManage ? 'Add an entry to start building the roster.' : 'Roster entries will appear here once added.'}
            action={canManage ? <button style={s.btn} onClick={openAdd}>+ Add Entry</button> : undefined}
          />
        ) : (
          <Table columns={columns} rows={entries} rowKey={e => e.id} />
        )}

        {total > LIMIT && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 16 }}>
            <button style={s.btnSm} disabled={page === 1} onClick={() => setPage(p => p - 1)}>← Prev</button>
            <span style={{ color: colors.textFaint, fontSize: 13 }}>Page {page} of {Math.ceil(total / LIMIT)}</span>
            <button style={s.btnSm} disabled={entries.length < LIMIT} onClick={() => setPage(p => p + 1)}>Next →</button>
          </div>
        )}
      </div>

      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add Roster Entry"
        footer={<>
          <button style={s.btnSecondary} onClick={() => setAddOpen(false)}>Cancel</button>
          <button style={s.btn} disabled={saving || !formValid} onClick={submitAdd}>
            {saving ? 'Saving…' : 'Add Entry'}
          </button>
        </>}
      >
        <RosterFormFields form={form} setForm={setForm} isEdit={false} crewOptions={crewOptions} jobSiteOptions={jobSiteOptions} />
      </Modal>

      <Modal
        open={!!editTarget}
        onClose={() => setEditTarget(null)}
        title="Edit Roster Entry"
        footer={<>
          <button style={s.btnSecondary} onClick={() => setEditTarget(null)}>Cancel</button>
          <button style={s.btn} disabled={saving || !editFormValid} onClick={submitEdit}>
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </>}
      >
        <RosterFormFields form={form} setForm={setForm} isEdit={true} crewOptions={crewOptions} jobSiteOptions={jobSiteOptions} />
      </Modal>

      <Modal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="Remove this roster entry?"
        width={420}
        footer={<>
          <button style={s.btnSecondary} onClick={() => setDeleteTarget(null)}>Cancel</button>
          <button style={s.btnDanger} disabled={deleting} onClick={confirmDelete}>
            {deleting ? 'Removing…' : 'Remove'}
          </button>
        </>}
      >
        <div style={{ color: colors.textMuted, fontSize: 14, lineHeight: 1.6 }}>
          Remove {deleteTarget?.crewMember?.fullName ?? 'this crew member'}'s draft roster entry
          {deleteTarget ? ` for ${new Date(deleteTarget.rosterDate).toLocaleDateString()}` : ''}? This cannot be undone.
        </div>
      </Modal>

      <Modal
        open={publishOpen}
        onClose={() => setPublishOpen(false)}
        title="Publish Roster Range"
        width={420}
        footer={<>
          <button style={s.btnSecondary} onClick={() => setPublishOpen(false)}>Cancel</button>
          <button style={s.btn} disabled={publishing || !publishFrom || !publishTo} onClick={submitPublish}>
            {publishing ? 'Publishing…' : 'Publish'}
          </button>
        </>}
      >
        <div style={{ display: 'grid', gap: 12 }}>
          <div style={{ color: colors.textMuted, fontSize: 13, lineHeight: 1.5 }}>
            All draft entries with a roster date in this range will be published and visible to crew.
          </div>
          <div>
            <label style={s.label} htmlFor="roster-publish-from">From</label>
            <input id="roster-publish-from" type="date" style={s.input} value={publishFrom} onChange={e => setPublishFrom(e.target.value)} required />
          </div>
          <div>
            <label style={s.label} htmlFor="roster-publish-to">To</label>
            <input id="roster-publish-to" type="date" style={s.input} value={publishTo} onChange={e => setPublishTo(e.target.value)} required />
          </div>
        </div>
      </Modal>
    </div>
  )
}
