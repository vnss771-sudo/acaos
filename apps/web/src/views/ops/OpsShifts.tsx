import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { OpsCreateShiftRequest, OpsUpdateShiftRequest, OpsClockInRequest, OpsClockOutRequest } from '@acaos/shared'
import type { ApiHook } from '../../hooks/useApi.js'
import type { ToastHook } from '../../hooks/useToast.js'
import type { View, Workspace, OpsShiftRecord, OpsCrewMember, OpsJobSite } from '../../types.js'
import { colors, s } from '../../styles.js'
import { makeRouteApi } from '../../lib/routeApi.js'
import { Card } from '../../components/ui/Card.js'
import { Table, type Column } from '../../components/ui/Table.js'
import { EmptyState } from '../../components/ui/EmptyState.js'
import { Skeleton } from '../../components/ui/Skeleton.js'
import { Badge } from '../../components/ui/Badge.js'
import { Modal } from '../../components/ui/Modal.js'
import { Grid } from '../../components/ui/Grid.js'
import { OpsSubNav } from '../../components/ops/OpsSubNav.js'

type Props = { api: ApiHook; workspace: Workspace | null; toast: ToastHook; canManage?: boolean; setView: (v: View) => void }

const LIMIT = 25

// Converts an ISO datetime string to the local `datetime-local` input format
// (YYYY-MM-DDTHH:mm) so an existing record's timestamp can populate a form
// field. Submission always goes the other way, via `new Date(value).toISOString()`.
function isoToLocalInput(iso?: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const BLANK_MANUAL_FORM = {
  crewMemberId: '', jobSiteId: '', shiftDate: '', startTime: '', endTime: '',
  breakMinutes: '', allowanceTag: '', outdoorHighRisk: false, notes: '',
}
type ManualForm = typeof BLANK_MANUAL_FORM

const BLANK_EDIT_FORM = {
  jobSiteId: '', endTime: '', breakMinutes: '', allowanceTag: '', outdoorHighRisk: false,
  heatCheckCompleted: false, fatigueConcern: false, corRelated: false, reviewed: false, notes: '',
}
type EditForm = typeof BLANK_EDIT_FORM

const checkboxLabel: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, color: colors.textMuted, fontSize: 13 }

export function OpsShifts({ api, workspace, toast, canManage = false, setView }: Props) {
  const route = useMemo(() => makeRouteApi(api), [api])

  // Shared reference data — active crew + active job sites. Fetched once per
  // workspace and used by both the clock widget and the history filters/forms.
  const [crewList, setCrewList] = useState<OpsCrewMember[]>([])
  const [jobSites, setJobSites] = useState<OpsJobSite[]>([])
  const crewById = useMemo(() => new Map(crewList.map(c => [c.id, c])), [crewList])
  const jobSiteById = useMemo(() => new Map(jobSites.map(j => [j.id, j])), [jobSites])

  useEffect(() => {
    if (!workspace) return
    let cancelled = false
    api<{ crew: OpsCrewMember[] }>(`/api/ops/crew?workspaceId=${workspace.id}&active=true&limit=100`)
      .then(d => {
        if (cancelled) return
        const list = d.crew || []
        setCrewList(list)
        // Default the clock widget to the first active crew member, but never
        // clobber a selection the person already made.
        setSelectedCrewId(prev => prev || (list[0]?.id ?? ''))
      })
      .catch(e => toast.error(e instanceof Error ? e.message : 'Failed to load crew'))
    api<{ jobSites: OpsJobSite[] }>(`/api/ops/jobs?workspaceId=${workspace.id}&status=ACTIVE&limit=100`)
      .then(d => { if (!cancelled) setJobSites(d.jobSites || []) })
      .catch(e => toast.error(e instanceof Error ? e.message : 'Failed to load job sites'))
    return () => { cancelled = true }
  }, [workspace?.id])

  // ── Clock in / out widget — membership-level, visible to any crew member ──
  const [selectedCrewId, setSelectedCrewId] = useState('')
  const [clockJobSiteId, setClockJobSiteId] = useState('')
  const [status, setStatus] = useState<{ clockedIn: boolean; shift: OpsShiftRecord | null } | null>(null)
  const [statusLoading, setStatusLoading] = useState(false)
  const [clockWorking, setClockWorking] = useState(false)

  useEffect(() => { setClockJobSiteId('') }, [selectedCrewId])

  const statusReqRef = useRef(0)
  const fetchStatus = useCallback(() => {
    if (!workspace || !selectedCrewId) { setStatus(null); return }
    const reqId = ++statusReqRef.current
    setStatusLoading(true)
    api<{ clockedIn: boolean; shift: OpsShiftRecord | null }>(`/api/ops/clock/status?workspaceId=${workspace.id}&crewMemberId=${selectedCrewId}`)
      .then(d => { if (reqId === statusReqRef.current) setStatus(d) })
      .catch(e => { if (reqId === statusReqRef.current) toast.error(e instanceof Error ? e.message : 'Failed to load clock status') })
      .finally(() => { if (reqId === statusReqRef.current) setStatusLoading(false) })
  }, [workspace?.id, selectedCrewId])

  useEffect(() => { fetchStatus() }, [fetchStatus])

  async function clockIn() {
    if (!workspace || !selectedCrewId || !clockJobSiteId) return
    setClockWorking(true)
    try {
      const body: OpsClockInRequest = { workspaceId: workspace.id, crewMemberId: selectedCrewId, jobSiteId: clockJobSiteId }
      await route('POST /api/ops/clock/in', { body })
      toast.success('Clocked in')
      setClockJobSiteId('')
      fetchStatus()
      fetchShifts()
    } catch (e) {
      // A double clock-in returns 409 with a clear message ("...clock out
      // first") — surface it as-is instead of a generic failure string.
      toast.error(e instanceof Error ? e.message : 'Failed to clock in')
    } finally { setClockWorking(false) }
  }

  async function clockOut() {
    if (!workspace || !selectedCrewId) return
    setClockWorking(true)
    try {
      const body: OpsClockOutRequest = { workspaceId: workspace.id, crewMemberId: selectedCrewId }
      const d = await route('POST /api/ops/clock/out', { body }) as { shift?: OpsShiftRecord }
      const hours = d?.shift?.totalHours
      toast.success(hours != null ? `Clocked out — ${hours}h logged` : 'Clocked out')
      fetchStatus()
      fetchShifts()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to clock out') }
    finally { setClockWorking(false) }
  }

  // ── Shift history ──────────────────────────────────────────────────────
  const [shifts, setShifts] = useState<OpsShiftRecord[]>([])
  const [shiftsTotal, setShiftsTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [filterCrewId, setFilterCrewId] = useState('')
  const [filterJobSiteId, setFilterJobSiteId] = useState('')
  const [filterFrom, setFilterFrom] = useState('')
  const [filterTo, setFilterTo] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  const [addOpen, setAddOpen] = useState(false)
  const [manualForm, setManualForm] = useState<ManualForm>(BLANK_MANUAL_FORM)
  const [editTarget, setEditTarget] = useState<OpsShiftRecord | null>(null)
  const [editForm, setEditForm] = useState<EditForm>(BLANK_EDIT_FORM)
  const [originalEndTime, setOriginalEndTime] = useState('')

  const shiftsReqRef = useRef(0)
  const fetchShifts = useCallback(() => {
    if (!workspace) return
    const reqId = ++shiftsReqRef.current
    setLoading(true)
    const params = new URLSearchParams({ workspaceId: workspace.id, page: String(page), limit: String(LIMIT) })
    if (filterCrewId) params.set('crewMemberId', filterCrewId)
    if (filterJobSiteId) params.set('jobSiteId', filterJobSiteId)
    if (filterFrom) params.set('from', new Date(filterFrom).toISOString())
    if (filterTo) params.set('to', new Date(filterTo).toISOString())
    api<{ shifts: OpsShiftRecord[]; total: number }>(`/api/ops/shifts?${params}`)
      .then(d => { if (reqId === shiftsReqRef.current) { setShifts(d.shifts || []); setShiftsTotal(d.total || 0) } })
      .catch(e => { if (reqId === shiftsReqRef.current) toast.error(e instanceof Error ? e.message : 'Failed to load shift history') })
      .finally(() => { if (reqId === shiftsReqRef.current) setLoading(false) })
  }, [workspace?.id, page, filterCrewId, filterJobSiteId, filterFrom, filterTo])

  useEffect(() => { fetchShifts() }, [fetchShifts])

  function openAdd() {
    setManualForm(BLANK_MANUAL_FORM)
    setAddOpen(true)
  }

  function openEdit(sh: OpsShiftRecord) {
    const endTimeLocal = isoToLocalInput(sh.endTime)
    setEditForm({
      jobSiteId: sh.jobSiteId,
      endTime: endTimeLocal,
      breakMinutes: String(sh.breakMinutes ?? 0),
      allowanceTag: sh.allowanceTag ?? '',
      outdoorHighRisk: sh.outdoorHighRisk,
      heatCheckCompleted: sh.heatCheckCompleted,
      fatigueConcern: sh.fatigueConcern,
      corRelated: sh.corRelated,
      reviewed: sh.reviewed,
      notes: sh.notes ?? '',
    })
    setOriginalEndTime(endTimeLocal)
    setEditTarget(sh)
  }

  async function submitAdd() {
    if (!workspace || !manualForm.crewMemberId || !manualForm.jobSiteId || !manualForm.shiftDate || !manualForm.startTime) return
    setSaving(true)
    try {
      const body: OpsCreateShiftRequest = {
        workspaceId: workspace.id,
        crewMemberId: manualForm.crewMemberId,
        jobSiteId: manualForm.jobSiteId,
        shiftDate: new Date(manualForm.shiftDate).toISOString(),
        startTime: new Date(manualForm.startTime).toISOString(),
        ...(manualForm.endTime ? { endTime: new Date(manualForm.endTime).toISOString() } : {}),
        ...(manualForm.breakMinutes.trim() ? { breakMinutes: Number(manualForm.breakMinutes) } : {}),
        ...(manualForm.allowanceTag.trim() ? { allowanceTag: manualForm.allowanceTag.trim() } : {}),
        outdoorHighRisk: manualForm.outdoorHighRisk,
        ...(manualForm.notes.trim() ? { notes: manualForm.notes.trim() } : {}),
      }
      await route('POST /api/ops/shifts', { body })
      setAddOpen(false)
      toast.success('Shift entry added')
      fetchShifts()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to add shift entry') }
    finally { setSaving(false) }
  }

  async function submitEdit() {
    if (!workspace || !editTarget) return
    setSaving(true)
    try {
      const body: OpsUpdateShiftRequest = {
        workspaceId: workspace.id,
        breakMinutes: Number(editForm.breakMinutes || 0),
        allowanceTag: editForm.allowanceTag.trim(),
        outdoorHighRisk: editForm.outdoorHighRisk,
        heatCheckCompleted: editForm.heatCheckCompleted,
        fatigueConcern: editForm.fatigueConcern,
        corRelated: editForm.corRelated,
        reviewed: editForm.reviewed,
        ...(editForm.notes.trim() ? { notes: editForm.notes.trim() } : {}),
        ...(editForm.jobSiteId && editForm.jobSiteId !== editTarget.jobSiteId ? { jobSiteId: editForm.jobSiteId } : {}),
        // CRITICAL: only include endTime when the person actually edited this
        // field in this form session (its value differs from what the shift
        // already had) AND left it non-empty. Omitting the key entirely — never
        // sending endTime: '' or undefined — is what keeps an already-open
        // shift open; see the bug this fixes in the PUT /api/ops/shifts/:id
        // handler's own comment (apps/api/src/routes/ops/shifts.ts).
        ...(editForm.endTime !== originalEndTime && editForm.endTime ? { endTime: new Date(editForm.endTime).toISOString() } : {}),
      }
      await route('PUT /api/ops/shifts/:id', { params: { id: editTarget.id }, body })
      setEditTarget(null)
      toast.success('Shift updated')
      fetchShifts()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to update shift') }
    finally { setSaving(false) }
  }

  const filtersActive = !!(filterCrewId || filterJobSiteId || filterFrom || filterTo)

  const columns: Column<OpsShiftRecord>[] = [
    { key: 'crewMember', header: 'Crew', render: sh => sh.crewMember?.fullName ?? crewById.get(sh.crewMemberId)?.fullName ?? '—' },
    { key: 'jobSite', header: 'Job Site', render: sh => sh.jobSite?.siteName ?? jobSiteById.get(sh.jobSiteId)?.siteName ?? '—' },
    { key: 'shiftDate', header: 'Date', render: sh => new Date(sh.shiftDate).toLocaleDateString() },
    {
      key: 'time', header: 'Start–End', render: sh => (
        <span>
          {new Date(sh.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          {' – '}
          {sh.endTime
            ? new Date(sh.endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : <Badge color={colors.green}>In progress</Badge>}
        </span>
      ),
    },
    { key: 'totalHours', header: 'Hours', render: sh => `${sh.totalHours}h` },
    {
      key: 'flags', header: 'Flags', render: sh => (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {sh.outdoorHighRisk && <Badge color={colors.amber}>Outdoor</Badge>}
          {sh.outdoorHighRisk && <Badge color={sh.heatCheckCompleted ? colors.green : colors.red}>Heat check {sh.heatCheckCompleted ? '✓' : '✗'}</Badge>}
          {sh.fatigueConcern && <Badge color={colors.red}>Fatigue</Badge>}
        </div>
      ),
    },
    ...(canManage ? [{
      key: 'actions', header: '', render: (sh: OpsShiftRecord) => (
        <div onClick={e => e.stopPropagation()}>
          <button style={s.btnSm} onClick={() => openEdit(sh)}>Edit</button>
        </div>
      ),
    } as Column<OpsShiftRecord>] : []),
  ]

  const activeShiftJobSiteName = status?.shift ? (jobSiteById.get(status.shift.jobSiteId)?.siteName ?? 'a job site') : ''
  const isClockedIn = !!(status?.clockedIn && status.shift)

  return (
    <div style={s.stack}>
      <OpsSubNav view="ops-shifts" setView={setView} />

      {/* Clock in / out — membership-level, visible to any crew member; not
          gated by canManage the way the shift-history mutations below are. */}
      <Card>
        <div style={s.sectionHeader}>Clock In / Out</div>
        <div style={{ display: 'grid', gap: 14 }}>
          <Grid cols={2}>
            <div>
              <label style={s.label} htmlFor="clock-crew-member">Crew Member</label>
              <select id="clock-crew-member" style={s.input} value={selectedCrewId} onChange={e => setSelectedCrewId(e.target.value)}>
                <option value="">Select crew member</option>
                {crewList.map(c => <option key={c.id} value={c.id}>{c.fullName}</option>)}
              </select>
            </div>
            {!isClockedIn && (
              <div>
                <label style={s.label} htmlFor="clock-job-site">Job Site</label>
                <select id="clock-job-site" style={s.input} value={clockJobSiteId} onChange={e => setClockJobSiteId(e.target.value)}>
                  <option value="">Select job site</option>
                  {jobSites.map(j => <option key={j.id} value={j.id}>{j.siteName}</option>)}
                </select>
              </div>
            )}
          </Grid>

          {!selectedCrewId ? null : statusLoading ? (
            <Skeleton height={40} />
          ) : isClockedIn && status?.shift ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
              <div style={{ color: colors.text, fontSize: 14 }}>
                Clocked in at {activeShiftJobSiteName} since {new Date(status.shift.startTime).toLocaleString()}
              </div>
              <button style={s.btnDanger} disabled={clockWorking} onClick={clockOut}>
                {clockWorking ? 'Clocking Out…' : 'Clock Out'}
              </button>
            </div>
          ) : (
            <div>
              <button style={s.btnSuccess} disabled={clockWorking || !clockJobSiteId} onClick={clockIn}>
                {clockWorking ? 'Clocking In…' : 'Clock In'}
              </button>
            </div>
          )}
        </div>
      </Card>

      {/* Shift history */}
      <Card>
        <div style={{ marginBottom: 16 }}>
          <Grid cols={4}>
            <div>
              <label style={s.label} htmlFor="filter-crew">Crew</label>
              <select id="filter-crew" style={s.input} value={filterCrewId} onChange={e => { setFilterCrewId(e.target.value); setPage(1) }}>
                <option value="">All</option>
                {crewList.map(c => <option key={c.id} value={c.id}>{c.fullName}</option>)}
              </select>
            </div>
            <div>
              <label style={s.label} htmlFor="filter-job-site">Site</label>
              <select id="filter-job-site" style={s.input} value={filterJobSiteId} onChange={e => { setFilterJobSiteId(e.target.value); setPage(1) }}>
                <option value="">All</option>
                {jobSites.map(j => <option key={j.id} value={j.id}>{j.siteName}</option>)}
              </select>
            </div>
            <div>
              <label style={s.label} htmlFor="filter-from">From</label>
              <input id="filter-from" type="date" style={s.input} value={filterFrom} onChange={e => { setFilterFrom(e.target.value); setPage(1) }} />
            </div>
            <div>
              <label style={s.label} htmlFor="filter-to">To</label>
              <input id="filter-to" type="date" style={s.input} value={filterTo} onChange={e => { setFilterTo(e.target.value); setPage(1) }} />
            </div>
          </Grid>
          {canManage && (
            <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end' }}>
              <button style={s.btn} onClick={openAdd}>+ Add Manual Entry</button>
            </div>
          )}
        </div>

        {loading && shifts.length === 0 ? (
          <div style={{ display: 'grid', gap: 10 }}>
            {[0, 1, 2, 3].map(i => <Skeleton key={i} height={36} />)}
          </div>
        ) : shifts.length === 0 ? (
          <EmptyState
            title="No shifts recorded yet"
            description={filtersActive ? 'No shifts match the selected filters.' : 'Clock a crew member in or add a manual entry to get started.'}
            action={canManage ? <button style={s.btn} onClick={openAdd}>+ Add Manual Entry</button> : undefined}
          />
        ) : (
          <Table columns={columns} rows={shifts} rowKey={sh => sh.id} />
        )}

        {shiftsTotal > LIMIT && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 16 }}>
            <button style={s.btnSm} disabled={page === 1} onClick={() => setPage(p => p - 1)}>← Prev</button>
            <span style={{ color: colors.textFaint, fontSize: 13 }}>Page {page} of {Math.ceil(shiftsTotal / LIMIT)}</span>
            <button style={s.btnSm} disabled={shifts.length < LIMIT} onClick={() => setPage(p => p + 1)}>Next →</button>
          </div>
        )}
      </Card>

      {/* Add manual entry — canManage only. A manual entry can be created
          already-closed or left open (End Time is optional). */}
      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add Manual Entry"
        width={560}
        footer={<>
          <button style={s.btnSecondary} onClick={() => setAddOpen(false)}>Cancel</button>
          <button
            style={s.btn}
            disabled={saving || !manualForm.crewMemberId || !manualForm.jobSiteId || !manualForm.shiftDate || !manualForm.startTime}
            onClick={submitAdd}
          >
            {saving ? 'Saving…' : 'Add Entry'}
          </button>
        </>}
      >
        <Grid cols={2}>
          <div>
            <label style={s.label} htmlFor="shift-add-crew">Crew Member</label>
            <select id="shift-add-crew" style={s.input} value={manualForm.crewMemberId} onChange={e => setManualForm(f => ({ ...f, crewMemberId: e.target.value }))} required>
              <option value="">Select crew member</option>
              {crewList.map(c => <option key={c.id} value={c.id}>{c.fullName}</option>)}
            </select>
          </div>
          <div>
            <label style={s.label} htmlFor="shift-add-job-site">Job Site</label>
            <select id="shift-add-job-site" style={s.input} value={manualForm.jobSiteId} onChange={e => setManualForm(f => ({ ...f, jobSiteId: e.target.value }))} required>
              <option value="">Select job site</option>
              {jobSites.map(j => <option key={j.id} value={j.id}>{j.siteName}</option>)}
            </select>
          </div>
          <div>
            <label style={s.label} htmlFor="shift-add-date">Shift Date</label>
            <input id="shift-add-date" type="datetime-local" style={s.input} value={manualForm.shiftDate} onChange={e => setManualForm(f => ({ ...f, shiftDate: e.target.value }))} required />
          </div>
          <div>
            <label style={s.label} htmlFor="shift-add-start">Start Time</label>
            <input id="shift-add-start" type="datetime-local" style={s.input} value={manualForm.startTime} onChange={e => setManualForm(f => ({ ...f, startTime: e.target.value }))} required />
          </div>
          <div>
            <label style={s.label} htmlFor="shift-add-end">End Time</label>
            <input id="shift-add-end" type="datetime-local" style={s.input} value={manualForm.endTime} onChange={e => setManualForm(f => ({ ...f, endTime: e.target.value }))} />
          </div>
          <div>
            <label style={s.label} htmlFor="shift-add-break">Break Minutes</label>
            <input id="shift-add-break" type="number" min={0} max={1440} style={s.input} value={manualForm.breakMinutes} onChange={e => setManualForm(f => ({ ...f, breakMinutes: e.target.value }))} />
          </div>
          <div>
            <label style={s.label} htmlFor="shift-add-allowance">Allowance Tag</label>
            <input id="shift-add-allowance" style={s.input} placeholder="e.g. TRAVEL" value={manualForm.allowanceTag} onChange={e => setManualForm(f => ({ ...f, allowanceTag: e.target.value }))} />
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end' }}>
            <label style={checkboxLabel} htmlFor="shift-add-outdoor">
              <input id="shift-add-outdoor" type="checkbox" checked={manualForm.outdoorHighRisk} onChange={e => setManualForm(f => ({ ...f, outdoorHighRisk: e.target.checked }))} />
              Outdoor High-Risk
            </label>
          </div>
          <div style={{ gridColumn: '1/-1' }}>
            <label style={s.label} htmlFor="shift-add-notes">Notes</label>
            <textarea id="shift-add-notes" style={{ ...s.textarea, height: 70 }} value={manualForm.notes} onChange={e => setManualForm(f => ({ ...f, notes: e.target.value }))} />
          </div>
        </Grid>
      </Modal>

      {/* Edit shift — canManage only. */}
      <Modal
        open={!!editTarget}
        onClose={() => setEditTarget(null)}
        title="Edit Shift"
        width={560}
        footer={<>
          <button style={s.btnSecondary} onClick={() => setEditTarget(null)}>Cancel</button>
          <button style={s.btn} disabled={saving} onClick={submitEdit}>{saving ? 'Saving…' : 'Save Changes'}</button>
        </>}
      >
        <Grid cols={2}>
          <div>
            <label style={s.label} htmlFor="shift-edit-job-site">Job Site</label>
            <select id="shift-edit-job-site" style={s.input} value={editForm.jobSiteId} onChange={e => setEditForm(f => ({ ...f, jobSiteId: e.target.value }))}>
              {editForm.jobSiteId && !jobSiteById.has(editForm.jobSiteId) && (
                <option value={editForm.jobSiteId}>{editTarget?.jobSite?.siteName ?? editForm.jobSiteId} (archived)</option>
              )}
              {jobSites.map(j => <option key={j.id} value={j.id}>{j.siteName}</option>)}
            </select>
          </div>
          <div>
            <label style={s.label} htmlFor="shift-edit-end">
              End Time{!originalEndTime && <span style={{ textTransform: 'none', letterSpacing: 0 }}> (leave blank to keep open)</span>}
            </label>
            <input id="shift-edit-end" type="datetime-local" style={s.input} value={editForm.endTime} onChange={e => setEditForm(f => ({ ...f, endTime: e.target.value }))} />
          </div>
          <div>
            <label style={s.label} htmlFor="shift-edit-break">Break Minutes</label>
            <input id="shift-edit-break" type="number" min={0} max={1440} style={s.input} value={editForm.breakMinutes} onChange={e => setEditForm(f => ({ ...f, breakMinutes: e.target.value }))} />
          </div>
          <div>
            <label style={s.label} htmlFor="shift-edit-allowance">Allowance Tag</label>
            <input id="shift-edit-allowance" style={s.input} value={editForm.allowanceTag} onChange={e => setEditForm(f => ({ ...f, allowanceTag: e.target.value }))} />
          </div>
          <label style={checkboxLabel} htmlFor="shift-edit-outdoor">
            <input id="shift-edit-outdoor" type="checkbox" checked={editForm.outdoorHighRisk} onChange={e => setEditForm(f => ({ ...f, outdoorHighRisk: e.target.checked }))} />
            Outdoor High-Risk
          </label>
          <label style={checkboxLabel} htmlFor="shift-edit-heat-check">
            <input id="shift-edit-heat-check" type="checkbox" checked={editForm.heatCheckCompleted} onChange={e => setEditForm(f => ({ ...f, heatCheckCompleted: e.target.checked }))} />
            Heat Check Completed
          </label>
          <label style={checkboxLabel} htmlFor="shift-edit-fatigue">
            <input id="shift-edit-fatigue" type="checkbox" checked={editForm.fatigueConcern} onChange={e => setEditForm(f => ({ ...f, fatigueConcern: e.target.checked }))} />
            Fatigue Concern
          </label>
          <label style={checkboxLabel} htmlFor="shift-edit-cor">
            <input id="shift-edit-cor" type="checkbox" checked={editForm.corRelated} onChange={e => setEditForm(f => ({ ...f, corRelated: e.target.checked }))} />
            COR-Related
          </label>
          <label style={checkboxLabel} htmlFor="shift-edit-reviewed">
            <input id="shift-edit-reviewed" type="checkbox" checked={editForm.reviewed} onChange={e => setEditForm(f => ({ ...f, reviewed: e.target.checked }))} />
            Reviewed
          </label>
          <div style={{ gridColumn: '1/-1' }}>
            <label style={s.label} htmlFor="shift-edit-notes">Notes</label>
            <textarea id="shift-edit-notes" style={{ ...s.textarea, height: 70 }} value={editForm.notes} onChange={e => setEditForm(f => ({ ...f, notes: e.target.value }))} />
          </div>
        </Grid>
      </Modal>
    </div>
  )
}
