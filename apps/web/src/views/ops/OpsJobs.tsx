import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { OpsCreateJobSiteRequest, OpsUpdateJobSiteRequest } from '@acaos/shared'
import type { ApiHook } from '../../hooks/useApi.js'
import type { ToastHook } from '../../hooks/useToast.js'
import type { View, Workspace, OpsJobSite, OpsRiskLevel } from '../../types.js'
import { colors, s } from '../../styles.js'
import { makeRouteApi } from '../../lib/routeApi.js'
import { Table, type Column } from '../../components/ui/Table.js'
import { EmptyState } from '../../components/ui/EmptyState.js'
import { Skeleton } from '../../components/ui/Skeleton.js'
import { Badge } from '../../components/ui/Badge.js'
import { Modal } from '../../components/ui/Modal.js'
import { OpsSubNav } from '../../components/ops/OpsSubNav.js'

type Props = { api: ApiHook; workspace: Workspace | null; toast: ToastHook; canManage?: boolean; setView: (v: View) => void }

const RISK_COLOR: Record<OpsRiskLevel, string> = { LOW: colors.green, MEDIUM: colors.amber, HIGH: colors.red }

const BLANK_FORM = {
  jobCode: '', siteName: '', location: '', supervisor: '', shiftType: '',
  riskLevel: 'MEDIUM' as OpsRiskLevel, lat: '', lng: '', radiusMeters: '500', notes: '',
}

type JobForm = typeof BLANK_FORM

function formToCreateBody(form: JobForm, workspaceId: string): OpsCreateJobSiteRequest {
  return {
    workspaceId,
    jobCode: form.jobCode.trim(),
    siteName: form.siteName.trim(),
    ...(form.location.trim() ? { location: form.location.trim() } : {}),
    ...(form.supervisor.trim() ? { supervisor: form.supervisor.trim() } : {}),
    ...(form.shiftType.trim() ? { shiftType: form.shiftType.trim() } : {}),
    riskLevel: form.riskLevel,
    ...(form.lat.trim() ? { lat: Number(form.lat) } : {}),
    ...(form.lng.trim() ? { lng: Number(form.lng) } : {}),
    ...(form.radiusMeters.trim() ? { radiusMeters: Number(form.radiusMeters) } : {}),
    ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
  }
}

function formToUpdateBody(form: JobForm, workspaceId: string): OpsUpdateJobSiteRequest {
  return {
    workspaceId,
    siteName: form.siteName.trim(),
    location: form.location.trim() || undefined,
    supervisor: form.supervisor.trim() || undefined,
    shiftType: form.shiftType.trim() || undefined,
    riskLevel: form.riskLevel,
    lat: form.lat.trim() ? Number(form.lat) : undefined,
    lng: form.lng.trim() ? Number(form.lng) : undefined,
    radiusMeters: form.radiusMeters.trim() ? Number(form.radiusMeters) : undefined,
    notes: form.notes.trim() || undefined,
  }
}

// Add/Edit form body shared by both modals. jobCode is only ever shown (never
// edited) once a job site exists — the backend rejects changing it.
function JobFormFields({ form, setForm, isEdit }: { form: JobForm; setForm: React.Dispatch<React.SetStateAction<JobForm>>; isEdit: boolean }) {
  const ff = (field: keyof JobForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [field]: e.target.value }))

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div>
        <label style={s.label} htmlFor="job-code">Job Code</label>
        {isEdit ? (
          <div id="job-code" style={{ ...s.input, color: colors.textFaint, background: colors.bgCard }}>{form.jobCode}</div>
        ) : (
          <input id="job-code" style={s.input} value={form.jobCode} onChange={ff('jobCode')} required />
        )}
      </div>
      <div>
        <label style={s.label} htmlFor="job-site-name">Site Name</label>
        <input id="job-site-name" style={s.input} value={form.siteName} onChange={ff('siteName')} required />
      </div>
      <div>
        <label style={s.label} htmlFor="job-location">Location</label>
        <input id="job-location" style={s.input} value={form.location} onChange={ff('location')} />
      </div>
      <div>
        <label style={s.label} htmlFor="job-supervisor">Supervisor</label>
        <input id="job-supervisor" style={s.input} value={form.supervisor} onChange={ff('supervisor')} />
      </div>
      <div>
        <label style={s.label} htmlFor="job-shift-type">Shift Type</label>
        <input id="job-shift-type" style={s.input} placeholder="e.g. Day, Night" value={form.shiftType} onChange={ff('shiftType')} />
      </div>
      <div>
        <label style={s.label} htmlFor="job-risk-level">Risk Level</label>
        <select id="job-risk-level" style={s.input} value={form.riskLevel} onChange={e => setForm(f => ({ ...f, riskLevel: e.target.value as OpsRiskLevel }))}>
          <option value="LOW">Low</option>
          <option value="MEDIUM">Medium</option>
          <option value="HIGH">High</option>
        </select>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <label style={s.label} htmlFor="job-lat">Latitude</label>
          <input id="job-lat" type="number" step="any" style={s.input} value={form.lat} onChange={ff('lat')} />
        </div>
        <div>
          <label style={s.label} htmlFor="job-lng">Longitude</label>
          <input id="job-lng" type="number" step="any" style={s.input} value={form.lng} onChange={ff('lng')} />
        </div>
      </div>
      <div>
        <label style={s.label} htmlFor="job-radius">Radius (meters)</label>
        <input id="job-radius" type="number" min={10} style={s.input} value={form.radiusMeters} onChange={ff('radiusMeters')} />
      </div>
      <div>
        <label style={s.label} htmlFor="job-notes">Notes</label>
        <textarea id="job-notes" style={{ ...s.textarea, height: 70 }} value={form.notes} onChange={ff('notes')} />
      </div>
    </div>
  )
}

export function OpsJobs({ api, workspace, toast, canManage = false, setView }: Props) {
  const route = useMemo(() => makeRouteApi(api), [api])
  const [jobSites, setJobSites] = useState<OpsJobSite[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [statusFilter, setStatusFilter] = useState<'' | 'ACTIVE' | 'ARCHIVED'>('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  const [addOpen, setAddOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<OpsJobSite | null>(null)
  const [archiveTarget, setArchiveTarget] = useState<OpsJobSite | null>(null)
  const [archiving, setArchiving] = useState(false)
  const [form, setForm] = useState<JobForm>(BLANK_FORM)

  const LIMIT = 25

  // Monotonic request id — see Leads.tsx / OpsCrew.tsx: the fetch runs both from
  // the effect (filter/page changes) and imperatively after add/edit/archive, so
  // only the most recent call may apply its result.
  const reqRef = useRef(0)
  const fetchJobs = useCallback(() => {
    if (!workspace) return
    const reqId = ++reqRef.current
    setLoading(true)
    const params = new URLSearchParams({ workspaceId: workspace.id, page: String(page), limit: String(LIMIT) })
    if (statusFilter) params.set('status', statusFilter)
    api<{ jobSites: OpsJobSite[]; total: number }>(`/api/ops/jobs?${params}`)
      .then(d => { if (reqId === reqRef.current) { setJobSites(d.jobSites || []); setTotal(d.total || 0) } })
      .catch(e => { if (reqId === reqRef.current) toast.error(e instanceof Error ? e.message : 'Failed to load job sites') })
      .finally(() => { if (reqId === reqRef.current) setLoading(false) })
  }, [workspace?.id, page, statusFilter])

  useEffect(() => { fetchJobs() }, [fetchJobs])

  function openAdd() {
    setForm(BLANK_FORM)
    setAddOpen(true)
  }

  function openEdit(site: OpsJobSite) {
    setForm({
      jobCode: site.jobCode,
      siteName: site.siteName,
      location: site.location ?? '',
      supervisor: site.supervisor ?? '',
      shiftType: site.shiftType ?? '',
      riskLevel: site.riskLevel,
      lat: site.lat != null ? String(site.lat) : '',
      lng: site.lng != null ? String(site.lng) : '',
      radiusMeters: String(site.radiusMeters),
      notes: site.notes ?? '',
    })
    setEditTarget(site)
  }

  async function submitAdd() {
    if (!workspace || !form.jobCode.trim() || !form.siteName.trim()) return
    setSaving(true)
    try {
      await route('POST /api/ops/jobs', { body: formToCreateBody(form, workspace.id) })
      setAddOpen(false)
      setForm(BLANK_FORM)
      toast.success('Job site added')
      fetchJobs()
    } catch (e) {
      // The backend returns a clear 409 message for a duplicate job code
      // ("A job site with this job code already exists") — surface it as-is.
      toast.error(e instanceof Error ? e.message : 'Failed to add job site')
    } finally { setSaving(false) }
  }

  async function submitEdit() {
    if (!workspace || !editTarget || !form.siteName.trim()) return
    setSaving(true)
    try {
      await route('PUT /api/ops/jobs/:id', { params: { id: editTarget.id }, body: formToUpdateBody(form, workspace.id) })
      setEditTarget(null)
      toast.success('Job site updated')
      fetchJobs()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to update job site') }
    finally { setSaving(false) }
  }

  async function confirmArchive() {
    if (!workspace || !archiveTarget) return
    setArchiving(true)
    try {
      await api(`/api/ops/jobs/${archiveTarget.id}?workspaceId=${workspace.id}`, { method: 'DELETE' })
      toast.success(`${archiveTarget.siteName} archived`)
      setArchiveTarget(null)
      fetchJobs()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to archive job site') }
    finally { setArchiving(false) }
  }

  const columns: Column<OpsJobSite>[] = [
    { key: 'siteName', header: 'Site Name', render: j => <span style={{ fontWeight: 500 }}>{j.siteName}</span> },
    { key: 'jobCode', header: 'Job Code' },
    { key: 'location', header: 'Location', render: j => j.location || '—' },
    { key: 'supervisor', header: 'Supervisor', render: j => j.supervisor || '—' },
    { key: 'riskLevel', header: 'Risk', render: j => <Badge color={RISK_COLOR[j.riskLevel]}>{j.riskLevel}</Badge> },
    { key: 'status', header: 'Status', render: j => <Badge color={j.status === 'ACTIVE' ? colors.green : colors.textFaint}>{j.status === 'ACTIVE' ? 'Active' : 'Archived'}</Badge> },
    ...(canManage ? [{
      key: 'actions', header: '', render: (j: OpsJobSite) => (
        <div style={{ display: 'flex', gap: 8 }} onClick={e => e.stopPropagation()}>
          <button style={s.btnSm} onClick={() => openEdit(j)}>Edit</button>
          {j.status === 'ACTIVE' && <button style={s.btnWarning} onClick={() => setArchiveTarget(j)}>Archive</button>}
        </div>
      ),
    } as Column<OpsJobSite>] : []),
  ]

  return (
    <div style={s.stack}>
      <OpsSubNav view="ops-jobs" setView={setView} />

      <div style={{ ...s.card, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <select style={{ ...s.input, width: 160 }} value={statusFilter} onChange={e => { setStatusFilter(e.target.value as '' | 'ACTIVE' | 'ARCHIVED'); setPage(1) }}>
          <option value="">All statuses</option>
          <option value="ACTIVE">Active</option>
          <option value="ARCHIVED">Archived</option>
        </select>
        <span style={{ color: colors.textFaint, fontSize: 13 }}>{total} job site{total === 1 ? '' : 's'}</span>
        {canManage && (
          <button style={{ ...s.btn, marginLeft: 'auto' }} onClick={openAdd}>+ Add Job Site</button>
        )}
      </div>

      <div style={s.card}>
        {loading && jobSites.length === 0 ? (
          <div style={{ display: 'grid', gap: 10 }}>
            {[0, 1, 2, 3].map(i => <Skeleton key={i} height={36} />)}
          </div>
        ) : jobSites.length === 0 ? (
          <EmptyState
            title="No job sites yet"
            description="Add a job site to start rostering crew and tracking shifts against it."
            action={canManage ? <button style={s.btn} onClick={openAdd}>+ Add Job Site</button> : undefined}
          />
        ) : (
          <Table columns={columns} rows={jobSites} rowKey={j => j.id} />
        )}

        {total > LIMIT && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 16 }}>
            <button style={s.btnSm} disabled={page === 1} onClick={() => setPage(p => p - 1)}>← Prev</button>
            <span style={{ color: colors.textFaint, fontSize: 13 }}>Page {page} of {Math.ceil(total / LIMIT)}</span>
            <button style={s.btnSm} disabled={jobSites.length < LIMIT} onClick={() => setPage(p => p + 1)}>Next →</button>
          </div>
        )}
      </div>

      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add Job Site"
        footer={<>
          <button style={s.btnSecondary} onClick={() => setAddOpen(false)}>Cancel</button>
          <button style={s.btn} disabled={saving || !form.jobCode.trim() || !form.siteName.trim()} onClick={submitAdd}>
            {saving ? 'Saving…' : 'Add Job Site'}
          </button>
        </>}
      >
        <JobFormFields form={form} setForm={setForm} isEdit={false} />
      </Modal>

      <Modal
        open={!!editTarget}
        onClose={() => setEditTarget(null)}
        title={`Edit ${editTarget?.siteName ?? ''}`}
        footer={<>
          <button style={s.btnSecondary} onClick={() => setEditTarget(null)}>Cancel</button>
          <button style={s.btn} disabled={saving || !form.siteName.trim()} onClick={submitEdit}>
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </>}
      >
        <JobFormFields form={form} setForm={setForm} isEdit={true} />
      </Modal>

      <Modal
        open={!!archiveTarget}
        onClose={() => setArchiveTarget(null)}
        title="Archive job site?"
        width={420}
        footer={<>
          <button style={s.btnSecondary} onClick={() => setArchiveTarget(null)}>Cancel</button>
          <button style={s.btnWarning} disabled={archiving} onClick={confirmArchive}>
            {archiving ? 'Archiving…' : 'Archive'}
          </button>
        </>}
      >
        <div style={{ color: colors.textMuted, fontSize: 14, lineHeight: 1.6 }}>
          Archive {archiveTarget?.siteName}? It will be removed from active rosters but its shift and roster history is kept.
        </div>
      </Modal>
    </div>
  )
}
