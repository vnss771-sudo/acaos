import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EvidenceFileSummary } from '@acaos/shared'
import { colors, s } from '../../styles.js'
import { Modal } from '../ui/Modal.js'
import { formatBytes } from '../../lib/evidence/persistence.js'
import { classifyGalleryError, GALLERY_ERROR_TEXT, makeGalleryApi, SignedUrlCache, type GalleryErrorKind } from '../../lib/evidence/galleryApi.js'

// Manager view of the photos technicians uploaded to one delivery Job (not the job site: a site can
// have several Jobs, each with its own evidence). Read-only: no upload, no delete. Everything comes from
// the C5a read endpoints; the server decides who may see what, so a revoked manager, another workspace
// or a file that is not available simply produce the matching message here.

type RawApi = <T = unknown>(path: string) => Promise<T>
type Props = { api: RawApi; workspaceId: string; jobId: string; jobLabel: string }

const TOUCH: React.CSSProperties = { minHeight: 44, minWidth: 44, boxSizing: 'border-box', cursor: 'pointer' }
const when = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
const photoName = (f: EvidenceFileSummary) => `photo from ${f.uploadedBy?.name ?? 'a technician'} at ${when(f.finalizedAt ?? f.createdAt)}`

type SignedState = { status: 'idle' | 'loading' | 'ok' | 'error'; url?: string; error?: GalleryErrorKind }

/** A signed link for one file, fetched once `wanted` is true. A failed image load asks for a fresh link once before giving up. */
function useSignedUrl(cache: SignedUrlCache, fileId: string, variant: 'thumb' | 'full', wanted: boolean, onForbidden: () => void) {
  const [st, setSt] = useState<SignedState>({ status: 'idle' })
  const retried = useRef(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const load = useCallback((fresh: boolean, manual = false) => {
    setSt((p) => ({ status: 'loading', url: fresh ? undefined : p.url }))
    cache.get(fileId, variant, { fresh, manual }).then(
      (url) => { if (alive.current) setSt({ status: 'ok', url }) },
      (e) => {
        const kind = classifyGalleryError(e)
        if (kind === 'forbidden') onForbidden()
        if (alive.current) setSt({ status: 'error', error: kind })
      },
    )
  }, [cache, fileId, variant, onForbidden])

  // A different file (the lightbox moving on) is a fresh request, never the previous file's link.
  useEffect(() => { retried.current = false; setSt({ status: 'idle' }) }, [fileId, variant])
  useEffect(() => { if (wanted && st.status === 'idle') load(false) }, [wanted, st.status, load])

  /** The <img> could not load the link (expired or revoked): one automatic refresh, then show the error. */
  const imageFailed = useCallback(() => {
    cache.forget(fileId, variant)
    if (!retried.current) { retried.current = true; load(true); return }
    setSt({ status: 'error', error: 'unavailable' })
  }, [cache, fileId, variant, load])

  // Only a person pressing Retry gets a fresh request through a rate-limit cooldown.
  const retry = useCallback(() => { retried.current = false; cache.forget(fileId, variant); load(true, true) }, [cache, fileId, variant, load])
  return { ...st, imageFailed, retry }
}

function useVisible<T extends Element>(): [React.RefObject<T>, boolean] {
  const ref = useRef<T>(null) as React.RefObject<T>
  const [seen, setSeen] = useState(typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    if (seen || !ref.current) return
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) { setSeen(true); io.disconnect() } }, { rootMargin: '200px' })
    io.observe(ref.current)
    return () => io.disconnect()
  }, [seen])
  return [ref, seen]
}

function Tile({ file, cache, onOpen, onForbidden }: { file: EvidenceFileSummary; cache: SignedUrlCache; onOpen: () => void; onForbidden: () => void }) {
  const [ref, visible] = useVisible<HTMLDivElement>()
  // Without a thumbnail the full image stands in (it is heavier, but the evidence still shows).
  const sig = useSignedUrl(cache, file.id, file.hasThumb ? 'thumb' : 'full', visible, onForbidden)
  const name = photoName(file)
  return (
    <li style={{ listStyle: 'none' }}>
      <div ref={ref} style={{ position: 'relative', width: '100%', aspectRatio: '1 / 1', borderRadius: 8, overflow: 'hidden', background: colors.border }}>
        {sig.status === 'ok' && sig.url && (
          <button type="button" onClick={onOpen} aria-label={`Open ${name}`} style={{ ...TOUCH, position: 'absolute', inset: 0, padding: 0, border: 'none', background: 'transparent' }}>
            <img src={sig.url} alt="" referrerPolicy="no-referrer" loading="lazy" onError={sig.imageFailed}
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
          </button>
        )}
        {(sig.status === 'idle' || sig.status === 'loading') && (
          <div role="status" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: colors.textMuted }}>Loading…</div>
        )}
        {sig.status === 'error' && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, padding: 6, textAlign: 'center', fontSize: 12, color: colors.text }}>
            <span>{sig.error === 'unavailable' || sig.error === 'not_found' ? 'Photo unavailable' : 'Could not load'}</span>
            {sig.error !== 'forbidden' && <button type="button" style={{ ...s.btnSm, ...TOUCH }} aria-label={`Retry ${name}`} onClick={sig.retry}>Retry</button>}
          </div>
        )}
      </div>
    </li>
  )
}

function Lightbox({ files, index, cache, hasMore, loadingMore, onMove, onLoadMore, onClose, onForbidden }: {
  files: EvidenceFileSummary[]; index: number; cache: SignedUrlCache; hasMore: boolean; loadingMore: boolean
  onMove: (i: number) => void; onLoadMore: () => void; onClose: () => void; onForbidden: () => void
}) {
  const file = files[index]
  const sig = useSignedUrl(cache, file.id, 'full', true, onForbidden)
  const [imgLoaded, setImgLoaded] = useState(false)
  useEffect(() => { setImgLoaded(false) }, [sig.url, file.id])
  const atEnd = index >= files.length - 1
  const next = () => { if (!atEnd) onMove(index + 1); else if (hasMore && !loadingMore) onLoadMore() }
  const prev = () => { if (index > 0) onMove(index - 1) }
  return (
    <Modal open onClose={onClose} width={720} title={`Photo ${index + 1} of ${files.length}${hasMore ? '+' : ''}`}
      footer={<button type="button" style={{ ...s.btnSm, ...TOUCH }} autoFocus onClick={onClose}>Close</button>}>
      <div onKeyDown={(e) => { if (e.key === 'ArrowRight') next(); else if (e.key === 'ArrowLeft') prev() }}>
        <div style={{ position: 'relative', minHeight: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', background: colors.border, borderRadius: 8, overflow: 'hidden' }}>
          {sig.status === 'ok' && sig.url && (
            <img key={file.id} src={sig.url} alt={`Full size ${photoName(file)}`} referrerPolicy="no-referrer" onLoad={() => setImgLoaded(true)} onError={sig.imageFailed}
              style={{ maxWidth: '100%', maxHeight: '60vh', display: 'block' }} />
          )}
          {sig.status !== 'error' && !(sig.status === 'ok' && imgLoaded) && (
            <div role="status" style={{ position: 'absolute', fontSize: 14, color: colors.text }}>Loading photo…</div>
          )}
          {sig.status === 'error' && (
            <div role="alert" style={{ padding: 16, textAlign: 'center', color: colors.text, fontSize: 14 }}>
              <div style={{ marginBottom: 8 }}>{sig.error === 'unavailable' ? 'This photo is not available right now.' : GALLERY_ERROR_TEXT[sig.error ?? 'failed']}</div>
              {sig.error !== 'forbidden' && <button type="button" style={{ ...s.btnSm, ...TOUCH }} onClick={sig.retry}>Try again</button>}
            </div>
          )}
        </div>
        <div style={{ marginTop: 10, fontSize: 14, color: colors.text }}>
          {file.uploadedBy ? <>Uploaded by <strong>{file.uploadedBy.name}</strong></> : 'Uploaded by a technician'} · {when(file.finalizedAt ?? file.createdAt)}
          {file.width && file.height ? ` · ${file.width}×${file.height}` : ''}{file.sizeBytes ? ` · ${formatBytes(file.sizeBytes)}` : ''}
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
          <button type="button" style={{ ...s.btnSm, ...TOUCH }} onClick={prev} disabled={index === 0}>Previous</button>
          <button type="button" style={{ ...s.btnSm, ...TOUCH }} onClick={next} disabled={atEnd && (!hasMore || loadingMore)}>{atEnd && hasMore ? (loadingMore ? 'Loading…' : 'Load more') : 'Next'}</button>
        </div>
      </div>
    </Modal>
  )
}

export function JobPhotoGallery({ api, workspaceId, jobId, jobLabel }: Props) {
  const apiRef = useRef(api); apiRef.current = api
  const scopeKey = `${workspaceId}\u0000${jobId}`
  const gallery = useMemo(() => makeGalleryApi(((p: string) => apiRef.current(p)) as RawApi, workspaceId, jobId), [workspaceId, jobId])
  const cache = useMemo(() => new SignedUrlCache(gallery.content), [gallery])

  const [open, setOpen] = useState(false)
  const [files, setFiles] = useState<EvidenceFileSummary[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [error, setError] = useState<GalleryErrorKind | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [viewing, setViewing] = useState<number | null>(null)
  const generation = useRef(0)

  // Another job or workspace is a different gallery: drop everything, including links and in-flight answers.
  useEffect(() => {
    generation.current++
    cache.clear()
    setOpen(false); setFiles([]); setCursor(null); setState('idle'); setError(null); setLoadingMore(false); setViewing(null)
    return () => { generation.current++; cache.clear() }
  }, [scopeKey, cache])

  /** The server said this person may no longer see the photos: show nothing of them. */
  const revoked = useCallback(() => {
    generation.current++
    cache.clear()
    setFiles([]); setCursor(null); setViewing(null); setState('error'); setError('forbidden')
  }, [cache])

  const loadFirst = useCallback(() => {
    const gen = ++generation.current
    setState('loading'); setError(null)
    gallery.list(null).then(
      (r) => { if (gen !== generation.current) return; setFiles(r.files); setCursor(r.nextCursor); setState('ready') },
      (e) => {
        if (gen !== generation.current) return
        const kind = classifyGalleryError(e)
        if (kind === 'forbidden') { revoked(); return }
        setFiles([]); setCursor(null); setError(kind); setState('error')
      },
    )
  }, [gallery, revoked])

  const loadMore = useCallback(() => {
    if (!cursor || loadingMore) return
    const gen = generation.current
    setLoadingMore(true)
    gallery.list(cursor).then(
      (r) => { if (gen !== generation.current) return; setFiles((prev) => { const seen = new Set(prev.map((f) => f.id)); return [...prev, ...r.files.filter((f) => !seen.has(f.id))] }); setCursor(r.nextCursor); setLoadingMore(false) },
      (e) => {
        if (gen !== generation.current) return
        const kind = classifyGalleryError(e)
        if (kind === 'forbidden') { revoked(); return }
        setLoadingMore(false); setError(kind)
      },
    )
  }, [gallery, cursor, loadingMore, revoked])

  const toggle = () => {
    const next = !open
    setOpen(next)
    // Every opening asks again: photos uploaded since the gallery was last open must appear without a page reload.
    if (next) loadFirst()
    if (!next) setViewing(null)
  }

  const panelId = `job-photos-${jobId}`
  return (
    <div style={{ marginTop: 10 }}>
      <button type="button" style={{ ...s.btnGhost, ...TOUCH }} aria-expanded={open} aria-controls={panelId} onClick={toggle}>
        {open ? 'Hide photos' : 'Photos'}
      </button>
      {open && (
        <div id={panelId} role="region" aria-label={`Photos for ${jobLabel}`} style={{ marginTop: 10 }}>
          {state === 'loading' && <div role="status" style={{ fontSize: 14, color: colors.textMuted }}>Loading photos…</div>}
          {state === 'error' && error && (
            <div role="alert" style={{ fontSize: 14, color: colors.text }}>
              <div style={{ marginBottom: 8 }}>{GALLERY_ERROR_TEXT[error]}</div>
              {error !== 'forbidden' && error !== 'disabled' && <button type="button" style={{ ...s.btnSm, ...TOUCH }} onClick={loadFirst}>Try again</button>}
            </div>
          )}
          {state === 'ready' && files.length === 0 && (
            <div style={{ fontSize: 14, color: colors.textMuted }}>No photos have been uploaded for this job yet.</div>
          )}
          {state === 'ready' && (
            <button type="button" style={{ ...s.btnGhost, ...TOUCH, marginBottom: 8 }} onClick={loadFirst}>Refresh photos</button>
          )}
          {state === 'ready' && files.length > 0 && (
            <>
              <ul aria-label={`Photo thumbnails for ${jobLabel}`} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(104px, 1fr))', gap: 8, margin: 0, padding: 0 }}>
                {files.map((f, i) => <Tile key={f.id} file={f} cache={cache} onOpen={() => setViewing(i)} onForbidden={revoked} />)}
              </ul>
              {error && state === 'ready' && <div role="alert" style={{ marginTop: 8, fontSize: 14, color: colors.text }}>{GALLERY_ERROR_TEXT[error]}</div>}
              {cursor && (
                <button type="button" style={{ ...s.btnSm, ...TOUCH, marginTop: 10 }} disabled={loadingMore} onClick={loadMore}>
                  {loadingMore ? 'Loading…' : 'Load more photos'}
                </button>
              )}
            </>
          )}
        </div>
      )}
      {viewing !== null && files[viewing] && (
        <Lightbox files={files} index={viewing} cache={cache} hasMore={cursor !== null} loadingMore={loadingMore}
          onMove={setViewing} onLoadMore={loadMore} onClose={() => setViewing(null)} onForbidden={revoked} />
      )}
    </div>
  )
}
