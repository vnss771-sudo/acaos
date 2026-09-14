import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { OpsCreateCrewRequest, OpsUpdateCrewRequest } from '@acaos/shared'
import type { ApiHook } from '../../hooks/useApi.js'
import type { ToastHook } from '../../hooks/useToast.js'
import type { View, Workspace, OpsCrewMember } from '../../types.js'
import { colors, s } from '../../styles.js'
import { makeRouteApi } from '../../lib/routeApi.js'
import { Table, type Column } from '../../components/ui/Table.js'
import { EmptyState } from '../../components/ui/EmptyState.js'
import { Skeleton } from '../../components/ui/Skeleton.js'
import { Badge } from '../../components/ui/Badge.js'
import { Modal } from '../../components/ui/Modal.js'
import { OpsSubNav } from '../../components/ops/OpsSubNav.js'

type Props = { api: ApiHook; workspace: Workspace | null; toast: ToastHook; canManage?: boolean; setView: (v: View) => void }

const BLANK_FORM = {
  employeeCode: '', fullName: '', role: '', crewName: '', baseRate: '', allowanceProfile: '', licenceNotes: '',
}

type CrewForm = typeof BLANK_FORM

function formToCreateBody(form: CrewForm, workspaceId: string): OpsCreateCrewRequest {
  return {
    workspaceId,
    employeeCode: form.employeeCode.trim(),
    fullName: form.fullName.trim(),
    role: form.role.trim(),
    ...(form.crewName.trim() ? { crewName: form.crewName.trim() } : {}),
    ...(form.baseRate.trim() ? { baseRate: Number(form.baseRate) } : {}),
    ...(form.allowanceProfile.trim() ? { allowanceProfile: form.allowanceProfile.trim() } : {}),
    ...(form.licenceNotes.trim() ? { licenceNotes: form.licenceNotes.trim() } : {}),
  }
}

function formToUpdateBody(form: CrewForm, workspaceId: string): OpsUpdateCrewRequest {
  return {
    workspaceId,
    fullName: form.fullName.trim(),
    role: form.role.trim(),
    crewName: form.crewName.trim() || undefined,
    baseRate: form.baseRate.trim() ? Number(form.baseRate) : undefined,
    allowanceProfile: form.allowanceProfile.trim() || undefined,
    licenceNotes: form.licenceNotes.trim() || undefined,
  }
}

// Add/Edit form body shared by both modals. employeeCode is only ever shown
// (never edited) once a crew member exists — the backend rejects changing it.
function CrewFormFields({ form, setForm, isEdit }: { form: CrewForm; setForm: React.Dispatch<React.SetStateAction<CrewForm>>; isEdit: boolean }) {
  const ff = (field: keyof CrewForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [field]: e.target.value }))

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div>
        <label style={s.label} htmlFor="crew-employee-code">Employee Code</label>
        {isEdit ? (
          <div id="crew-employee-code" style={{ ...s.input, color: colors.textFaint, background: colors.bgCard }}>{form.employeeCode}</div>
        ) : (
          <input id="crew-employee-code" style={s.input} value={form.employeeCode} onChange={ff('employeeCode')} required />
        )}
      </div>
      <div>
        <label style={s.label} htmlFor="crew-full-name">Full Name</label>
        <input id="crew-full-name" style={s.input} value={form.fullName} onChange={ff('fullName')} required />
      </div>
      <div>
        <label style={s.label} htmlFor="crew-role">Role</label>
        <input id="crew-role" style={s.input} value={form.role} onChange={ff('role')} required />
      </div>
      <div>
        <label style={s.label} htmlFor="crew-crew-name">Crew Name</label>
        <input id="crew-crew-name" style={s.input} value={form.crewName} onChange={ff('crewName')} />
      </div>
      <div>
        <label style={s.label} htmlFor="crew-base-rate">Base Rate ($/hr)</label>
        <input id="crew-base-rate" type="number" min={0} step="0.01" style={s.input} value={form.baseRate} onChange={ff('baseRate')} />
      </div>
      <div>
        <label style={s.label} htmlFor="crew-allowance-profile">Allowance Profile</label>
        <input id="crew-allowance-profile" style={s.input} value={form.allowanceProfile} onChange={ff('allowanceProfile')} />
      </div>
      <div>
        <label style={s.label} htmlFor="crew-licence-notes">Licence Notes</label>
        <textarea id="crew-licence-notes" style={{ ...s.textarea, height: 70 }} value={form.licenceNotes} onChange={ff('licenceNotes')} />
      </div>
    </div>
  )
}

export function OpsCrew({ api, workspace, toast, canManage = false, setView }: Props) {
  const route = useMemo(() => makeRouteApi(api), [api])
  const [crew, setCrew] = useState<OpsCrewMember[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [activeOnly, setActiveOnly] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  const [addOpen, setAddOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<OpsCrewMember | null>(null)
  const [deactivateTarget, setDeactivateTarget] = useState<OpsCrewMember | null>(null)
  const [deactivating, setDeactivating] = useState(false)
  const [form, setForm] = useState<CrewForm>(BLANK_FORM)

  const LIMIT = 25

  // Monotonic request id — see Leads.tsx: the fetch runs both from the effect
  // (search/filter/page changes) and imperatively after add/edit/deactivate, so
  // only the most recent call may apply its result.
  const reqRef = useRef(0)
  const fetchCrew = useCallback(() => {
    if (!workspace) return
    const reqId = ++reqRef.current
    setLoading(true)
    const params = new URLSearchParams({ workspaceId: workspace.id, page: String(page), limit: String(LIMIT) })
    if (search.trim()) params.set('search', search.trim())
    if (activeOnly) params.set('active', 'true')
    api<{ crew: OpsCrewMember[]; total: number }>(`/api/ops/crew?${params}`)
      .then(d => { if (reqId === reqRef.current) { setCrew(d.crew || []); setTotal(d.total || 0) } })
      .catch(e => { if (reqId === reqRef.current) toast.error(e instanceof Error ? e.message : 'Failed to load crew') })
      .finally(() => { if (reqId === reqRef.current) setLoading(false) })
  }, [workspace?.id, page, search, activeOnly])

  useEffect(() => { fetchCrew() }, [fetchCrew])

  function openAdd() {
    setForm(BLANK_FORM)
    setAddOpen(true)
  }

  function openEdit(member: OpsCrewMember) {
    setForm({
      employeeCode: member.employeeCode,
      fullName: member.fullName,
      role: member.role,
      crewName: member.crewName ?? '',
      baseRate: member.baseRate != null ? String(member.baseRate) : '',
      allowanceProfile: member.allowanceProfile ?? '',
      licenceNotes: member.licenceNotes ?? '',
    })
    setEditTarget(member)
  }

  async function submitAdd() {
    if (!workspace || !form.employeeCode.trim() || !form.fullName.trim() || !form.role.trim()) return
    setSaving(true)
    try {
      await route('POST /api/ops/crew', { body: formToCreateBody(form, workspace.id) })
      setAddOpen(false)
      setForm(BLANK_FORM)
      toast.success('Crew member added')
      fetchCrew()
    } catch (e) {
      // The backend returns a clear 409 message for a duplicate employee code
      // ("A crew member with this employee code already exists") — surface it
      // as-is rather than a generic failure string.
      toast.error(e instanceof Error ? e.message : 'Failed to add crew member')
    } finally { setSaving(false) }
  }

  async function submitEdit() {
    if (!workspace || !editTarget || !form.fullName.trim() || !form.role.trim()) return
    setSaving(true)
    try {
      await route('PUT /api/ops/crew/:id', { params: { id: editTarget.id }, body: formToUpdateBody(form, workspace.id) })
      setEditTarget(null)
      toast.success('Crew member updated')
      fetchCrew()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to update crew member') }
    finally { setSaving(false) }
  }

  async function confirmDeactivate() {
    if (!workspace || !deactivateTarget) return
    setDeactivating(true)
    try {
      await api(`/api/ops/crew/${deactivateTarget.id}?workspaceId=${workspace.id}`, { method: 'DELETE' })
      toast.success(`${deactivateTarget.fullName} deactivated`)
      setDeactivateTarget(null)
      fetchCrew()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to deactivate crew member') }
    finally { setDeactivating(false) }
  }

  const columns: Column<OpsCrewMember>[] = [
    { key: 'fullName', header: 'Name', render: m => <span style={{ fontWeight: 500 }}>{m.fullName}</span> },
    { key: 'employeeCode', header: 'Employee Code' },
    { key: 'role', header: 'Role' },
    { key: 'baseRate', header: 'Rate', render: m => m.baseRate != null ? `$${m.baseRate}/hr` : '—' },
    { key: 'isActive', header: 'Status', render: m => <Badge color={m.isActive ? colors.green : colors.textFaint}>{m.isActive ? 'Active' : 'Inactive'}</Badge> },
    ...(canManage ? [{
      key: 'actions', header: '', render: (m: OpsCrewMember) => (
        <div style={{ display: 'flex', gap: 8 }} onClick={e => e.stopPropagation()}>
          <button style={s.btnSm} onClick={() => openEdit(m)}>Edit</button>
          {m.isActive && <button style={s.btnWarning} onClick={() => setDeactivateTarget(m)}>Deactivate</button>}
        </div>
      ),
    } as Column<OpsCrewMember>] : []),
  ]

  return (
    <div style={s.stack}>
      <OpsSubNav view="ops-crew" setView={setView} />

      <div style={{ ...s.card, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          style={{ ...s.input, width: 220 }}
          placeholder="Search crew…"
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1) }}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: colors.textMuted, fontSize: 13 }}>
          <input type="checkbox" checked={activeOnly} onChange={e => { setActiveOnly(e.target.checked); setPage(1) }} />
          Active only
        </label>
        <span style={{ color: colors.textFaint, fontSize: 13 }}>{total} crew member{total === 1 ? '' : 's'}</span>
        {canManage && (
          <button style={{ ...s.btn, marginLeft: 'auto' }} onClick={openAdd}>+ Add Crew Member</button>
        )}
      </div>

      <div style={s.card}>
        {loading && crew.length === 0 ? (
          <div style={{ display: 'grid', gap: 10 }}>
            {[0, 1, 2, 3].map(i => <Skeleton key={i} height={36} />)}
          </div>
        ) : crew.length === 0 ? (
          <EmptyState
            title="No crew members yet"
            description="Add your field crew to start rostering shifts and tracking hours."
            action={canManage ? <button style={s.btn} onClick={openAdd}>+ Add Crew Member</button> : undefined}
          />
        ) : (
          <Table columns={columns} rows={crew} rowKey={m => m.id} />
        )}

        {total > LIMIT && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 16 }}>
            <button style={s.btnSm} disabled={page === 1} onClick={() => setPage(p => p - 1)}>← Prev</button>
            <span style={{ color: colors.textFaint, fontSize: 13 }}>Page {page} of {Math.ceil(total / LIMIT)}</span>
            <button style={s.btnSm} disabled={crew.length < LIMIT} onClick={() => setPage(p => p + 1)}>Next →</button>
          </div>
        )}
      </div>

      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add Crew Member"
        footer={<>
          <button style={s.btnSecondary} onClick={() => setAddOpen(false)}>Cancel</button>
          <button style={s.btn} disabled={saving || !form.employeeCode.trim() || !form.fullName.trim() || !form.role.trim()} onClick={submitAdd}>
            {saving ? 'Saving…' : 'Add Crew Member'}
          </button>
        </>}
      >
        <CrewFormFields form={form} setForm={setForm} isEdit={false} />
      </Modal>

      <Modal
        open={!!editTarget}
        onClose={() => setEditTarget(null)}
        title={`Edit ${editTarget?.fullName ?? ''}`}
        footer={<>
          <button style={s.btnSecondary} onClick={() => setEditTarget(null)}>Cancel</button>
          <button style={s.btn} disabled={saving || !form.fullName.trim() || !form.role.trim()} onClick={submitEdit}>
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </>}
      >
        <CrewFormFields form={form} setForm={setForm} isEdit={true} />
      </Modal>

      <Modal
        open={!!deactivateTarget}
        onClose={() => setDeactivateTarget(null)}
        title="Deactivate crew member?"
        width={420}
        footer={<>
          <button style={s.btnSecondary} onClick={() => setDeactivateTarget(null)}>Cancel</button>
          <button style={s.btnWarning} disabled={deactivating} onClick={confirmDeactivate}>
            {deactivating ? 'Deactivating…' : 'Deactivate'}
          </button>
        </>}
      >
        <div style={{ color: colors.textMuted, fontSize: 14, lineHeight: 1.6 }}>
          Deactivate {deactivateTarget?.fullName}? They will be removed from active rosters but their history is kept.
        </div>
      </Modal>
    </div>
  )
}
