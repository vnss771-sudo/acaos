// Read side of the manager evidence gallery: list a job's photos and get short-lived signed links.
// Everything goes through the C5a endpoints (`/api/ops/technician/:jobId/files[...]`); there is no
// second photo system. Links are bearer credentials (60 s), so they are kept in memory only, never
// logged, never stored, and re-requested when they expire.
import type { EvidenceFileContentResponse, EvidenceFileListResponse } from '@acaos/shared'

type RawApi = <T = unknown>(path: string) => Promise<T>

export type GalleryErrorKind = 'disabled' | 'forbidden' | 'not_found' | 'unavailable' | 'rate_limited' | 'failed'

/** Map an API failure to something the gallery can explain. Only the status is read; no message text is shown. */
export function classifyGalleryError(e: unknown): GalleryErrorKind {
  const status = (e as { status?: number } | null)?.status
  if (status === 503) return 'disabled'
  if (status === 401 || status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 409 || status === 410) return 'unavailable'
  if (status === 429) return 'rate_limited'
  return 'failed'
}

export const GALLERY_ERROR_TEXT: Record<GalleryErrorKind, string> = {
  disabled: 'Photo evidence is not enabled.',
  forbidden: 'You no longer have access to this job’s photos.',
  not_found: 'This photo is no longer available.',
  unavailable: 'This photo is not available.',
  rate_limited: 'Too many requests. Wait a moment and try again.',
  failed: 'Could not load photos. Check your connection and try again.',
}

export const GALLERY_PAGE_SIZE = 24

export type GalleryApi = {
  list: (cursor: string | null) => Promise<EvidenceFileListResponse>
  content: (fileId: string, variant: 'thumb' | 'full') => Promise<EvidenceFileContentResponse>
}

export function makeGalleryApi(api: RawApi, workspaceId: string, jobId: string): GalleryApi {
  const base = `/api/ops/technician/${encodeURIComponent(jobId)}/files`
  const ws = `workspaceId=${encodeURIComponent(workspaceId)}`
  return {
    list: (cursor) => api<EvidenceFileListResponse>(`${base}?${ws}&limit=${GALLERY_PAGE_SIZE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
    content: (fileId, variant) => api<EvidenceFileContentResponse>(`${base}/${encodeURIComponent(fileId)}/content?${ws}&variant=${variant}`),
  }
}

const rateLimited = () => Object.assign(new Error('rate limited'), { status: 429 })
const abandoned = () => new Error('abandoned')

/**
 * In-memory cache of signed links (never persisted, never logged). A link is reused only while it has
 * comfortably more than `marginMs` left, so an image is never started on a link that is about to lapse.
 * One in-flight request per (file, variant) is shared by everyone who asks.
 *
 * Request pressure is bounded here, not in the components: at most `maxConcurrentThumbs` thumbnail links
 * are requested at once (the rest wait), and after any 429 no automatic request is sent for `cooldownMs`
 * (those fail immediately, locally, as 429 so the tile shows its manual Retry). Only a person's explicit
 * action (`manual`) and full-size viewing skip the cooldown. Nothing here retries by itself.
 */
export class SignedUrlCache {
  private entries = new Map<string, { url: string; expiresAt: number }>()
  private pending = new Map<string, Promise<string>>()
  private waiting: Array<() => void> = []
  private active = 0
  private coolUntil = 0
  private epoch = 0
  private maxThumbs: number
  private cooldownMs: number
  constructor(
    private fetchContent: GalleryApi['content'],
    private now: () => number = Date.now,
    private marginMs = 10_000,
    opts: { maxConcurrentThumbs?: number; cooldownMs?: number } = {},
  ) {
    this.maxThumbs = opts.maxConcurrentThumbs ?? 4
    this.cooldownMs = opts.cooldownMs ?? 10_000
  }

  private key = (fileId: string, variant: string) => `${variant}:${fileId}`

  async get(fileId: string, variant: 'thumb' | 'full', opts: { fresh?: boolean; manual?: boolean } = {}): Promise<string> {
    const k = this.key(fileId, variant)
    if (!opts.fresh) {
      const hit = this.entries.get(k)
      if (hit && hit.expiresAt - this.now() > this.marginMs) return hit.url
      const inflight = this.pending.get(k)
      if (inflight) return inflight
    }
    const epoch = this.epoch
    const run = () => this.fetchContent(fileId, variant)
    const p = (variant === 'thumb' ? this.limited(run, !!opts.manual, epoch) : run()).then((r) => {
      // A cache that was cleared (workspace/job change, revoked access) must not be repopulated by a late answer.
      if (epoch === this.epoch) this.entries.set(k, { url: r.url, expiresAt: Date.parse(r.expiresAt) || this.now() })
      return r.url
    }).finally(() => { if (this.pending.get(k) === p) this.pending.delete(k) })
    this.pending.set(k, p)
    return p
  }

  private async limited<T>(run: () => Promise<T>, manual: boolean, epoch: number): Promise<T> {
    while (this.active >= this.maxThumbs) {
      await new Promise<void>((r) => this.waiting.push(r))
      if (epoch !== this.epoch) throw abandoned()          // the view went away while this was queued: send nothing
    }
    if (!manual && this.now() < this.coolUntil) {
      this.waiting.shift()?.()                               // pass the slot on so the rest of the queue also fails fast
      throw rateLimited()
    }
    this.active++
    try {
      return await run()
    } catch (e) {
      if ((e as { status?: number } | null)?.status === 429) this.coolUntil = this.now() + this.cooldownMs
      throw e
    } finally {
      this.active--
      this.waiting.shift()?.()
    }
  }

  forget(fileId: string, variant: 'thumb' | 'full') { this.entries.delete(this.key(fileId, variant)) }

  clear() {
    this.epoch++
    this.entries.clear()
    this.pending.clear()
    this.coolUntil = 0
    for (const w of this.waiting.splice(0)) w()            // queued requests wake, see the new epoch and drop
  }
}
