import React, { useMemo, useRef, useState } from 'react'
import { colors, s } from '../../styles.js'
import { ProgressBar } from '../ui/ProgressBar.js'
import { Modal } from '../ui/Modal.js'
import { formatBytes } from '../../lib/evidence/persistence.js'
import type { ItemView } from '../../lib/evidence/uploadEngine.js'
import { usePhotoUploads, type PhotoUploads } from './PhotoUploadProvider.js'

// The technician's photo screen for one job: take or choose photos, watch them upload, retry or remove
// them. Everything here is a view over the upload engine (queue, retries, idempotency and limits live
// there). Photos are processed on the phone, saved on the phone, and uploaded in the background; the
// wording never promises more than that.

const TOUCH: React.CSSProperties = { minHeight: 48, minWidth: 48, fontSize: 16, borderRadius: 10, boxSizing: 'border-box', cursor: 'pointer' }
const primary: React.CSSProperties = { ...TOUCH, flex: '1 1 160px', border: 'none', background: colors.blue, color: '#fff', fontWeight: 600, padding: '0 16px' }
const secondary: React.CSSProperties = { ...TOUCH, flex: '1 1 160px', border: `1px solid ${colors.border}`, background: 'transparent', color: colors.text, padding: '0 16px' }
const small: React.CSSProperties = { ...TOUCH, border: `1px solid ${colors.border}`, background: 'transparent', color: colors.text, padding: '0 14px' }

type Note = { id: number; text: string }

const timeLabel = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** What to tell the person about one photo. Fixed strings only (errorText comes from the engine's fixed table). */
export function describe(i: ItemView, online: boolean): { label: string; tone: 'neutral' | 'good' | 'bad' | 'busy' } {
  switch (i.state) {
    case 'queued':
      if (i.errorText) return { label: i.errorText, tone: 'neutral' }
      return { label: online ? 'Waiting to upload' : 'Waiting for a connection', tone: 'neutral' }
    case 'uploading': return { label: `Uploading ${Math.round(i.progress * 100)}%`, tone: 'busy' }
    case 'processing': return { label: 'Uploaded. Checking the photo…', tone: 'busy' }
    case 'cancelling': return { label: 'Removing…', tone: 'neutral' }
    case 'failed': return { label: `${i.errorText ?? 'Upload stopped.'} Your photo is still saved on this phone.`, tone: 'bad' }
    case 'rejected': return { label: `${i.errorText ?? 'This photo was not saved.'} This photo was not uploaded.`, tone: 'bad' }
    case 'done': return { label: 'Uploaded', tone: 'good' }
  }
}

export function PhotosTab({ jobId }: { jobId: string }) {
  const p = usePhotoUploads()
  const camera = useRef<HTMLInputElement>(null)
  const gallery = useRef<HTMLInputElement>(null)
  const noteId = useRef(0)
  const [busy, setBusy] = useState(0)
  const [problems, setProblems] = useState<Note[]>([])
  const [announce, setAnnounce] = useState('')
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null)

  // Opening the tab is what wakes the engine, so queued photos resume and new ones can be added.
  React.useEffect(() => { p?.activate() }, [p?.activate])

  const items = useMemo(() => (p?.snapshot.items ?? []).filter((i) => i.jobId === jobId).sort((a, b) => b.createdAt - a.createdAt), [p?.snapshot.items, jobId])
  if (!p) return null
  const { snapshot } = p
  const unsent = items.filter((i) => ['queued', 'uploading', 'processing', 'failed'].includes(i.state)).length
  const failed = items.filter((i) => i.state === 'failed').length

  async function pick(files: FileList | null, input: HTMLInputElement | null) {
    const list = Array.from(files ?? [])
    if (input) input.value = '' // let the same photo be chosen again
    if (!list.length || !p) return
    setBusy((n) => n + 1)
    setAnnounce(list.length === 1 ? 'Preparing photo…' : `Preparing ${list.length} photos…`)
    try {
      const results = await p.addPhotos(jobId, list)
      const bad = results.filter((r) => !r.result.ok)
      const added = results.length - bad.length
      setProblems((prev) => [...prev, ...bad.map((r) => ({ id: ++noteId.current, text: `${r.name || 'Photo'}: ${r.result.ok ? '' : r.result.message}` }))])
      setAnnounce(added ? `${added} photo${added === 1 ? '' : 's'} added. ${bad.length ? `${bad.length} could not be added.` : ''}` : 'No photos were added.')
    } finally {
      setBusy((n) => n - 1)
    }
  }

  const persistenceNote = p.persistence === 'granted'
    ? 'Your browser has agreed to keep these photos while they wait, but they can still be lost, for example if you clear browsing data or the phone runs out of space.'
    : 'Your browser may delete these photos if the phone is low on space or you clear browsing data.'

  return (
    <div style={s.card}>
      <h3 style={{ margin: '0 0 6px', fontSize: 16, color: colors.text }}>Photos</h3>
      <p style={{ margin: '0 0 12px', fontSize: 14, color: colors.textMuted }}>
        Photos are saved on this phone first, then upload on their own, even if you lose signal. They are resized and location data is removed before they are sent.
      </p>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        <button type="button" style={primary} onClick={() => camera.current?.click()}>Take photo</button>
        <button type="button" style={secondary} onClick={() => gallery.current?.click()}>Choose from gallery</button>
      </div>
      <input ref={camera} type="file" accept="image/*" capture="environment" data-testid="photo-camera-input" aria-label="Take a photo with the camera"
        style={{ display: 'none' }} tabIndex={-1} onChange={(e) => void pick(e.target.files, e.target)} />
      <input ref={gallery} type="file" accept="image/*" multiple data-testid="photo-gallery-input" aria-label="Choose photos from the gallery"
        style={{ display: 'none' }} tabIndex={-1} onChange={(e) => void pick(e.target.files, e.target)} />

      <div aria-live="polite" role="status" style={{ minHeight: 20, marginTop: 10, fontSize: 14, color: colors.textMuted }}>
        {busy > 0 ? 'Preparing photo…' : announce}
      </div>

      {!snapshot.online && (
        <div role="status" style={{ ...s.cardInner, marginTop: 8, borderColor: colors.amber, color: colors.text, fontSize: 14 }}>
          No connection. Photos will upload when you are back online.
        </div>
      )}
      {snapshot.paused === 'session' && (
        <div role="alert" style={{ ...s.cardInner, marginTop: 8, borderColor: colors.red, color: colors.text, fontSize: 14 }}>
          You are signed out, so nothing is uploading. Sign in again to continue; your photos are still saved on this phone.
        </div>
      )}
      {problems.length > 0 && (
        <div role="alert" style={{ ...s.cardInner, marginTop: 8, borderColor: colors.red, color: colors.text, fontSize: 14 }}>
          {problems.map((n) => <div key={n.id} style={{ marginBottom: 6 }}>{n.text}</div>)}
          <button type="button" style={small} onClick={() => setProblems([])}>Dismiss</button>
        </div>
      )}

      {unsent > 0 && (
        <div style={{ marginTop: 12, fontSize: 14, color: colors.text }}>
          <strong>{unsent}</strong> photo{unsent === 1 ? '' : 's'} saved on this phone and not yet uploaded{failed ? ` (${failed} stopped)` : ''}.
          <div style={{ fontSize: 13, color: colors.textMuted, marginTop: 4 }}>{persistenceNote}</div>
        </div>
      )}

      {items.length > 0 && (
        <ul aria-label="Photos for this job" style={{ listStyle: 'none', margin: '12px 0 0', padding: 0 }}>
          {items.map((i) => <PhotoRow key={i.id} item={i} online={snapshot.online} p={p} onRemove={() => setConfirmRemoveId(i.id)} />)}
        </ul>
      )}
      {items.length === 0 && busy === 0 && (
        <p style={{ margin: '14px 0 0', fontSize: 14, color: colors.textMuted }}>No photos waiting. Take one or choose from your gallery.</p>
      )}

      <RemoveDialog item={items.find((i) => i.id === confirmRemoveId) ?? null} onClose={() => setConfirmRemoveId(null)} onRemove={(id) => { setConfirmRemoveId(null); void p.cancel(id) }} />
    </div>
  )
}

/** Confirm before deleting an unsent photo. If the upload finished while the question was open, say so instead. */
function RemoveDialog({ item, onClose, onRemove }: { item: ItemView | null; onClose: () => void; onRemove: (id: string) => void }) {
  const finished = item?.state === 'done'
  return (
    <Modal open={item !== null} onClose={onClose} title={finished ? 'Already uploaded' : 'Remove this photo?'} width={400}
      footer={finished
        ? <button type="button" style={small} autoFocus onClick={onClose}>OK</button>
        : (
          <>
            <button type="button" style={small} autoFocus onClick={onClose}>Keep it</button>
            <button type="button" style={{ ...small, background: colors.red, border: 'none', color: '#fff', fontWeight: 600 }}
              onClick={() => item && onRemove(item.id)}>Remove photo</button>
          </>
        )}>
      <p style={{ margin: 0, color: colors.text, fontSize: 15 }}>
        {finished
          ? 'This photo finished uploading and is now part of the job, so it was not removed.'
          : 'Removing it stops the upload and deletes the photo from this phone. This cannot be undone. If it has already reached the job, it stays in the job.'}
      </p>
    </Modal>
  )
}

function PhotoRow({ item, online, p, onRemove }: { item: ItemView; online: boolean; p: PhotoUploads; onRemove: () => void }) {
  const d = describe(item, online)
  const name = `Photo from ${timeLabel(item.createdAt)}`
  const active = item.state === 'queued' || item.state === 'uploading' || item.state === 'processing'
  const color = d.tone === 'good' ? colors.green : d.tone === 'bad' ? colors.red : colors.textMuted
  return (
    <li style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', padding: '10px 0', borderTop: `1px solid ${colors.borderLight}` }}>
      {item.preview
        ? <img src={item.preview} alt={`Preview of ${name}`} width={64} height={64} style={{ objectFit: 'cover', borderRadius: 8, flex: '0 0 64px' }} referrerPolicy="no-referrer" />
        : <div aria-hidden="true" style={{ width: 64, height: 64, borderRadius: 8, background: colors.border, flex: '0 0 64px' }} />}
      <div style={{ flex: '1 1 160px', minWidth: 0 }}>
        <div style={{ fontSize: 15, color: colors.text }}>{name}</div>
        <div style={{ fontSize: 13, color: colors.textFaint }}>{formatBytes(item.sizeBytes)}</div>
        <div role="status" style={{ fontSize: 14, color, marginTop: 2 }}>{d.label}</div>
        {item.state === 'uploading' && (
          <div style={{ marginTop: 6 }} aria-label={`Upload progress for ${name}`}>
            <ProgressBar value={Math.round(item.progress * 100)} />
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {item.state === 'failed' && <button type="button" style={small} aria-label={`Retry ${name}`} onClick={() => void p.retry(item.id)}>Retry</button>}
        {(active || item.state === 'failed') && (
          <button type="button" style={small} aria-label={`${item.state === 'failed' ? 'Remove' : 'Cancel'} ${name}`}
            onClick={() => (item.hasPhoto ? onRemove() : void p.cancel(item.id))}>
            {item.state === 'failed' ? 'Remove' : 'Cancel'}
          </button>
        )}
        {(item.state === 'done' || item.state === 'rejected') && (
          <button type="button" style={small} aria-label={`Clear ${name} from the list`} onClick={() => void p.dismiss(item.id)}>Clear</button>
        )}
      </div>
    </li>
  )
}
