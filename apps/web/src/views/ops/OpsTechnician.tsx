import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TechnicianEvidenceRequest } from '@acaos/shared'
import type { ApiHook } from '../../hooks/useApi.js'
import type { ToastHook } from '../../hooks/useToast.js'
import type { Workspace } from '../../types.js'
import { colors, s } from '../../styles.js'
import { makeRouteApi } from '../../lib/routeApi.js'
import { EmptyState } from '../../components/ui/EmptyState.js'
import { Skeleton } from '../../components/ui/Skeleton.js'
import { Badge } from '../../components/ui/Badge.js'
import { PhotosTab } from '../../components/photos/PhotosTab.js'
import { usePhotoUploads } from '../../components/photos/PhotoUploadProvider.js'

// Mobile-first technician view: the caller's own assigned jobs, and per job a
// notes / checklist submission form plus the evidence already on the job. It sits
// on the existing /api/ops/technician endpoints and the normal session auth, so
// everything a worker can see or do is decided server-side by their per-job
// assignment. Photos, job start/complete and customer reports are out of scope.

type Props = { api: ApiHook; workspace: Workspace | null; toast: ToastHook }

type AssignedJob = { id: string; status: string; siteName: string | null; jobCode: string | null; assignedAt: string }
type ChecklistItem = { label: string; checked: boolean }
type EvidenceRow = {
  id: string; kind: 'NOTE' | 'CHECKLIST'; createdAt: string
  content: { note?: string; checklist?: ChecklistItem[] }
}
type Tab = 'notes' | 'checklist' | 'photos' | 'history'
type SendState = { phase: 'idle' | 'sending' | 'failed' | 'saved'; message?: string }

const NOTE_MAX = 4000
const LABEL_MAX = 200
const ITEMS_MAX = 100
const PAGE = 20

/** RFC 4122 v4 id. crypto.randomUUID needs a secure context; older Android WebViews lack it. */
export function newSubmissionId(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  const b = new Uint8Array(16)
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b)
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = Array.from(b, x => x.toString(16).padStart(2, '0'))
  return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10).join('')}`
}

const TOUCH: React.CSSProperties = { minHeight: 48, fontSize: 16, borderRadius: 10, boxSizing: 'border-box' }
const primaryBtn: React.CSSProperties = {
  ...TOUCH, width: '100%', border: 'none', background: colors.blue, color: '#fff', fontWeight: 600, cursor: 'pointer', padding: '0 16px',
}
const secondaryBtn: React.CSSProperties = {
  ...TOUCH, border: `1px solid ${colors.border}`, background: 'transparent', color: colors.text, cursor: 'pointer', padding: '0 14px',
}

export function OpsTechnician({ api, workspace, toast }: Props) {
  const wsId = workspace?.id ?? ''
  const [jobs, setJobs] = useState<AssignedJob[] | null>(null)
  const [linked, setLinked] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selected, setSelected] = useState<AssignedJob | null>(null)
  // The server says whether photo uploads are enabled; the Photos tab exists only then (and only inside the app shell that owns the upload engine).
  const [photosEnabled, setPhotosEnabled] = useState(false)

  const loadJobs = useCallback(async () => {
    if (!wsId) return
    setLoadError(null)
    try {
      const r = await api<{ linked: boolean; photos?: boolean; jobs: AssignedJob[] }>(`/api/ops/technician/assigned?workspaceId=${encodeURIComponent(wsId)}`)
      setLinked(r.linked)
      setPhotosEnabled(r.photos === true)
      setJobs(r.jobs)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load your jobs')
    }
  }, [api, wsId])

  useEffect(() => { void loadJobs() }, [loadJobs])

  if (!workspace) return null

  return (
    <div style={{ maxWidth: 560, margin: '0 auto', padding: '4px 0 32px' }}>
      {selected
        ? <JobDetail api={api} workspaceId={wsId} job={selected} toast={toast} photosEnabled={photosEnabled}
            onBack={() => { setSelected(null); void loadJobs() }} />
        : (
          <>
            <h2 style={{ margin: '0 0 12px', fontSize: 20, color: colors.text }}>My jobs</h2>
            {loadError && (
              <div role="alert" style={{ ...s.cardInner, borderColor: colors.red, marginBottom: 12 }}>
                <div style={{ color: colors.text, marginBottom: 10 }}>{loadError}</div>
                <button type="button" style={secondaryBtn} onClick={() => void loadJobs()}>Try again</button>
              </div>
            )}
            {!loadError && jobs === null && <Skeleton />}
            {!loadError && jobs !== null && !linked && (
              <EmptyState title="Your account isn't linked to a crew profile"
                description="Ask a manager to link your login to your crew record and assign you to a job." />
            )}
            {!loadError && jobs !== null && linked && jobs.length === 0 && (
              <EmptyState title="No jobs assigned" description="Jobs a manager assigns to you appear here." />
            )}
            {jobs !== null && linked && jobs.map(j => (
              <button key={j.id} type="button" onClick={() => setSelected(j)}
                style={{ ...s.card, display: 'block', width: '100%', textAlign: 'left', marginBottom: 10, cursor: 'pointer', minHeight: 64, color: colors.text }}>
                <div style={{ fontSize: 16, fontWeight: 600 }}>{j.siteName ?? 'Job'}</div>
                <div style={{ fontSize: 13, color: colors.textMuted, marginTop: 4 }}>
                  {j.jobCode ? `${j.jobCode} · ` : ''}Assigned {new Date(j.assignedAt).toLocaleDateString()}
                </div>
              </button>
            ))}
          </>
        )}
    </div>
  )
}

function JobDetail({ api, workspaceId, job, toast, photosEnabled, onBack }: {
  api: ApiHook; workspaceId: string; job: AssignedJob; toast: ToastHook; photosEnabled: boolean; onBack: () => void
}) {
  const [tab, setTab] = useState<Tab>('notes')
  const uploads = usePhotoUploads()
  const showPhotos = photosEnabled && uploads !== null
  const waiting = (uploads?.snapshot.items ?? []).filter(i => i.jobId === job.id && ['queued', 'uploading', 'processing', 'failed'].includes(i.state)).length
  const [history, setHistory] = useState<EvidenceRow[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const base = `/api/ops/technician/${encodeURIComponent(job.id)}/evidence`

  const loadHistory = useCallback(async (after: string | null) => {
    setHistoryError(null)
    try {
      const qs = `workspaceId=${encodeURIComponent(workspaceId)}&limit=${PAGE}${after ? `&cursor=${encodeURIComponent(after)}` : ''}`
      const r = await api<{ evidence: EvidenceRow[]; nextCursor: string | null }>(`${base}?${qs}`)
      if (!mounted.current) return
      setHistory(prev => (after ? [...prev, ...r.evidence] : r.evidence))
      setCursor(r.nextCursor)
      setHistoryLoaded(true)
    } catch (e) {
      if (mounted.current) setHistoryError(e instanceof Error ? e.message : 'Could not load evidence')
    }
  }, [api, base, workspaceId])

  useEffect(() => { void loadHistory(null) }, [loadHistory])

  // One submit path for both kinds. The submission id travels with the draft: it
  // is reused on a retry of the same content (the server returns the original
  // evidence instead of a duplicate) and regenerated by the form whenever the
  // content changes.
  const route = useMemo(() => makeRouteApi(api), [api])
  const submit = useCallback(async (payload: { kind: 'NOTE'; note: string } | { kind: 'CHECKLIST'; checklist: ChecklistItem[] }, submissionId: string) => {
    const body: TechnicianEvidenceRequest = { workspaceId, submissionId, ...payload }
    await route('POST /api/ops/technician/:jobId/evidence', { params: { jobId: job.id }, body })
    toast.success('Saved')
    await loadHistory(null)
  }, [route, job.id, loadHistory, toast, workspaceId])

  return (
    <div>
      <button type="button" style={{ ...secondaryBtn, marginBottom: 12 }} onClick={onBack}>← My jobs</button>
      <div style={{ ...s.card, marginBottom: 12 }}>
        <div style={{ fontSize: 18, fontWeight: 600, color: colors.text }}>{job.siteName ?? 'Job'}</div>
        <div style={{ fontSize: 13, color: colors.textMuted, marginTop: 4 }}>
          {job.jobCode ? `${job.jobCode} · ` : ''}<Badge color={colors.green}>{job.status}</Badge>
        </div>
      </div>

      <div role="tablist" aria-label="Job sections" style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {([['notes', 'Note'], ['checklist', 'Checklist'], ...(showPhotos ? [['photos', waiting ? `Photos (${waiting})` : 'Photos']] : []), ['history', 'History']] as [Tab, string][]).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
            style={{ ...secondaryBtn, flex: 1, background: tab === id ? colors.blue : 'transparent', color: tab === id ? '#fff' : colors.text }}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'notes' && <NoteForm onSubmit={(note, id) => submit({ kind: 'NOTE', note }, id)} onJobGone={onBack} />}
      {tab === 'checklist' && <ChecklistForm onSubmit={(items, id) => submit({ kind: 'CHECKLIST', checklist: items }, id)} onJobGone={onBack} />}
      {tab === 'photos' && showPhotos && <PhotosTab jobId={job.id} />}
      {tab === 'history' && (
        <History rows={history} loaded={historyLoaded} error={historyError} hasMore={cursor !== null}
          onMore={() => void loadHistory(cursor)} onRetry={() => void loadHistory(null)} />
      )}
    </div>
  )
}

/** Server messages that mean this job can no longer take evidence (retrying cannot help). */
function isTerminal(message: string): boolean {
  return /not active|revoked|not assigned/i.test(message)
}

function useSender(onJobGone: () => void) {
  const [state, setState] = useState<SendState>({ phase: 'idle' })
  const run = async (fn: () => Promise<void>): Promise<boolean> => {
    setState({ phase: 'sending' })
    try {
      await fn()
      setState({ phase: 'saved', message: 'Saved.' })
      return true
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not save'
      setState({ phase: 'failed', message })
      if (isTerminal(message)) window.setTimeout(onJobGone, 1500)
      return false
    }
  }
  return { state, run }
}

function Status({ state }: { state: SendState }) {
  if (state.phase === 'idle' || state.phase === 'sending') {
    return <div aria-live="polite" style={{ minHeight: 20 }} />
  }
  return (
    <div role={state.phase === 'failed' ? 'alert' : 'status'} aria-live="polite"
      style={{ marginTop: 10, fontSize: 14, color: state.phase === 'failed' ? colors.red : colors.green }}>
      {state.phase === 'failed' ? `${state.message} — your entry is kept. Tap Retry.` : state.message}
    </div>
  )
}

function NoteForm({ onSubmit, onJobGone }: { onSubmit: (note: string, id: string) => Promise<void>; onJobGone: () => void }) {
  const [draft, setDraft] = useState(() => ({ text: '', id: newSubmissionId() }))
  const { state, run } = useSender(onJobGone)
  const trimmed = draft.text.trim()
  const send = async () => {
    const ok = await run(() => onSubmit(trimmed, draft.id))
    if (ok) setDraft({ text: '', id: newSubmissionId() })
  }
  return (
    <div style={s.card}>
      <label htmlFor="tech-note" style={{ display: 'block', color: colors.textMuted, fontSize: 13, marginBottom: 6 }}>What did you do or find?</label>
      <textarea id="tech-note" rows={6} maxLength={NOTE_MAX} value={draft.text}
        onChange={e => setDraft({ text: e.target.value, id: newSubmissionId() })}
        style={{ ...s.textarea, fontSize: 16 }} />
      <div style={{ fontSize: 12, color: colors.textFaint, margin: '6px 0 12px' }}>{draft.text.length}/{NOTE_MAX}</div>
      <button type="button" style={{ ...primaryBtn, opacity: !trimmed || state.phase === 'sending' ? 0.6 : 1 }}
        disabled={!trimmed || state.phase === 'sending'} onClick={() => void send()}>
        {state.phase === 'sending' ? 'Saving…' : state.phase === 'failed' ? 'Retry' : 'Save note'}
      </button>
      <Status state={state} />
    </div>
  )
}

function ChecklistForm({ onSubmit, onJobGone }: { onSubmit: (items: ChecklistItem[], id: string) => Promise<void>; onJobGone: () => void }) {
  const [draft, setDraft] = useState(() => ({ items: [] as ChecklistItem[], id: newSubmissionId() }))
  const [label, setLabel] = useState('')
  const { state, run } = useSender(onJobGone)
  const change = (items: ChecklistItem[]) => setDraft({ items, id: newSubmissionId() })
  const add = () => {
    const l = label.trim()
    if (!l || draft.items.length >= ITEMS_MAX) return
    change([...draft.items, { label: l, checked: false }])
    setLabel('')
  }
  const send = async () => {
    const ok = await run(() => onSubmit(draft.items, draft.id))
    if (ok) setDraft({ items: [], id: newSubmissionId() })
  }
  return (
    <div style={s.card}>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {draft.items.map((it, i) => (
          <li key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 48, borderBottom: `1px solid ${colors.borderLight}` }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, minHeight: 48, color: colors.text, fontSize: 16 }}>
              <input type="checkbox" checked={it.checked} style={{ width: 24, height: 24 }}
                onChange={e => change(draft.items.map((x, j) => (j === i ? { ...x, checked: e.target.checked } : x)))} />
              <span>{it.label}</span>
            </label>
            <button type="button" aria-label={`Remove ${it.label}`} style={{ ...secondaryBtn, minWidth: 48, padding: 0 }}
              onClick={() => change(draft.items.filter((_, j) => j !== i))}>✕</button>
          </li>
        ))}
      </ul>
      <div style={{ display: 'flex', gap: 8, margin: '12px 0' }}>
        <input aria-label="New checklist item" value={label} maxLength={LABEL_MAX} placeholder="Add an item"
          onChange={e => setLabel(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
          style={{ ...s.input, ...TOUCH, flex: 1 }} />
        <button type="button" style={secondaryBtn} onClick={add} disabled={!label.trim() || draft.items.length >= ITEMS_MAX}>Add</button>
      </div>
      <button type="button" style={{ ...primaryBtn, opacity: draft.items.length === 0 || state.phase === 'sending' ? 0.6 : 1 }}
        disabled={draft.items.length === 0 || state.phase === 'sending'} onClick={() => void send()}>
        {state.phase === 'sending' ? 'Saving…' : state.phase === 'failed' ? 'Retry' : 'Save checklist'}
      </button>
      <Status state={state} />
    </div>
  )
}

function History({ rows, loaded, error, hasMore, onMore, onRetry }: {
  rows: EvidenceRow[]; loaded: boolean; error: string | null; hasMore: boolean; onMore: () => void; onRetry: () => void
}) {
  if (error) {
    return (
      <div role="alert" style={s.cardInner}>
        <div style={{ color: colors.text, marginBottom: 10 }}>{error}</div>
        <button type="button" style={secondaryBtn} onClick={onRetry}>Try again</button>
      </div>
    )
  }
  if (!loaded) return <Skeleton />
  if (rows.length === 0) return <EmptyState title="Nothing recorded yet" description="Notes and checklists you save appear here." />
  return (
    <div>
      {rows.map(r => (
        <div key={r.id} style={{ ...s.card, marginBottom: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: colors.textMuted, marginBottom: 6 }}>
            <Badge color={r.kind === 'NOTE' ? colors.blue : colors.green}>{r.kind === 'NOTE' ? 'Note' : 'Checklist'}</Badge>
            <span>{new Date(r.createdAt).toLocaleString()}</span>
          </div>
          {r.kind === 'NOTE'
            ? <div style={{ color: colors.text, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{r.content.note}</div>
            : <ul style={{ margin: 0, paddingLeft: 20, color: colors.text }}>
              {(r.content.checklist ?? []).map((it, i) => <li key={i}>{it.checked ? '☑' : '☐'} {it.label}</li>)}
            </ul>}
        </div>
      ))}
      {hasMore && <button type="button" style={{ ...secondaryBtn, width: '100%' }} onClick={onMore}>Load more</button>}
    </div>
  )
}
