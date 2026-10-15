import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within, fireEvent, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { EvidenceFileSummary } from '@acaos/shared'
import { JobPhotoGallery } from './JobPhotoGallery.js'
import { SignedUrlCache, classifyGalleryError } from '../../lib/evidence/galleryApi.js'

// A fake of the C5a read endpoints, with the failure modes the real server has.
const httpErr = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status })
const file = (i: number, over: Partial<EvidenceFileSummary> = {}): EvidenceFileSummary => ({
  id: `f${i}`, status: 'AVAILABLE', kind: 'PHOTO', contentType: 'image/jpeg', sizeBytes: 200_000 + i, width: 1600, height: 1200,
  evidenceId: null, createdAt: new Date(Date.UTC(2026, 9, 1, 9, i)).toISOString(), finalizedAt: new Date(Date.UTC(2026, 9, 1, 9, i, 30)).toISOString(),
  hasThumb: true, uploadedBy: { crewMemberId: 'c1', name: 'Sam Tech' }, ...over,
})

class Server {
  files: EvidenceFileSummary[] = []
  calls: string[] = []
  contentErrors = new Map<string, number>()      // `${variant}:${id}` -> status
  listError: number | null = null
  listGate: Promise<void> | null = null
  ttlMs = 60_000
  n = 0
  api = async (path: string): Promise<unknown> => {
    this.calls.push(path)
    const u = new URL(path, 'https://app.test')
    const m = u.pathname.match(/\/files(?:\/([^/]+)\/content)?$/)
    if (!m) throw httpErr(404)
    if (!m[1]) {
      if (this.listGate) await this.listGate
      if (this.listError) throw httpErr(this.listError)
      const limit = Number(u.searchParams.get('limit') ?? 50)
      const at = Number(u.searchParams.get('cursor') ?? 0)
      const page = this.files.slice(at, at + limit)
      return { files: page, nextCursor: at + limit < this.files.length ? String(at + limit) : null }
    }
    const variant = u.searchParams.get('variant') ?? 'full'
    const err = this.contentErrors.get(`${variant}:${m[1]}`)
    if (err) throw httpErr(err)
    return { url: `https://storage.example.test/${variant}/${m[1]}?sig=${++this.n}`, expiresAt: new Date(Date.now() + this.ttlMs).toISOString(), variant }
  }
  contentCalls = (variant?: string) => this.calls.filter((c) => c.includes('/content') && (!variant || c.includes(`variant=${variant}`)))
}

let srv: Server
beforeEach(() => { srv = new Server(); srv.files = Array.from({ length: 5 }, (_, i) => file(i)).reverse() })

const mount = (props: Partial<React.ComponentProps<typeof JobPhotoGallery>> = {}) =>
  render(<JobPhotoGallery api={srv.api as never} workspaceId="ws-1" jobId="job-1" jobLabel="J-1 · Smith St" {...props} />)
const open = async () => { await userEvent.click(screen.getByRole('button', { name: 'Photos' })) }

describe('loading and thumbnails', () => {
  it('stays closed and makes no request until opened', () => {
    mount()
    expect(srv.calls).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Photos' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('opening loads the first page (24) for this workspace and job, then signed thumbnails', async () => {
    let release!: () => void
    srv.listGate = new Promise<void>((r) => { release = r })
    mount()
    await open()
    expect(screen.getByRole('status')).toHaveTextContent('Loading photos')
    release()
    const list = await screen.findByRole('list', { name: 'Photo thumbnails for J-1 · Smith St' })
    expect(srv.calls[0]).toBe('/api/ops/technician/job-1/files?workspaceId=ws-1&limit=24')
    await waitFor(() => expect(within(list).getAllByRole('button')).toHaveLength(5))
    const imgs = list.querySelectorAll('img')
    expect(imgs).toHaveLength(5)
    imgs.forEach((i) => { expect(i.getAttribute('src')).toMatch(/^https:\/\/storage\.example\.test\/thumb\//); expect(i.getAttribute('referrerpolicy')).toBe('no-referrer') })
    expect(srv.contentCalls().every((c) => c.includes('variant=thumb'))).toBe(true)   // no full-size downloads for the grid
    expect(screen.getAllByRole('button', { name: /Open photo from Sam Tech/ })).toHaveLength(5)
  })

  it('shows an empty state', async () => {
    srv.files = []
    mount(); await open()
    expect(await screen.findByText('No photos have been uploaded for this job yet.')).toBeInTheDocument()
  })

  it('a file without a thumbnail uses the full image in the grid', async () => {
    srv.files = [file(1, { hasThumb: false })]
    mount(); await open()
    await waitFor(() => expect(srv.contentCalls('full')).toHaveLength(1))
    expect(srv.contentCalls('thumb')).toHaveLength(0)
  })

  it('never writes a signed link into visible text', async () => {
    mount(); await open()
    await waitFor(() => expect(document.querySelectorAll('img')).toHaveLength(5))
    expect(document.body.textContent).not.toMatch(/storage\.example\.test|sig=/)
  })
})

describe('pagination', () => {
  it('loads more on request, appends without duplicates, and hides the button at the end', async () => {
    srv.files = Array.from({ length: 30 }, (_, i) => file(i)).reverse()
    mount(); await open()
    const list = await screen.findByRole('list', { name: /Photo thumbnails/ })
    expect(within(list).getAllByRole('listitem')).toHaveLength(24)
    await userEvent.click(screen.getByRole('button', { name: 'Load more photos' }))
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(30))
    expect(srv.calls.some((c) => c.includes('cursor=24'))).toBe(true)
    expect(screen.queryByRole('button', { name: 'Load more photos' })).not.toBeInTheDocument()
  })

  it('thumbnails are requested only as tiles become visible (not all pages at once)', async () => {
    const observers: Array<{ cb: IntersectionObserverCallback; el: Element[] }> = []
    vi.stubGlobal('IntersectionObserver', class {
      cb: IntersectionObserverCallback; el: Element[] = []
      constructor(cb: IntersectionObserverCallback) { this.cb = cb; observers.push(this) }
      observe(e: Element) { this.el.push(e) } disconnect() {} unobserve() {} takeRecords() { return [] }
    })
    try {
      srv.files = Array.from({ length: 6 }, (_, i) => file(i))
      mount(); await open()
      await screen.findByRole('list', { name: /Photo thumbnails/ })
      expect(srv.contentCalls()).toHaveLength(0)
      act(() => { observers[0].cb([{ isIntersecting: true } as IntersectionObserverEntry], observers[0] as never) })
      await waitFor(() => expect(srv.contentCalls()).toHaveLength(1))
    } finally { vi.unstubAllGlobals() }
  })
})

describe('errors', () => {
  it('a failed load explains itself and can be retried', async () => {
    srv.listError = 500
    mount(); await open()
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load photos')
    srv.listError = null
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('list', { name: /Photo thumbnails/ })).toBeInTheDocument()
  })

  it('503 (uploads not enabled) says so and offers no retry', async () => {
    srv.listError = 503
    mount(); await open()
    expect(await screen.findByRole('alert')).toHaveTextContent('Photo evidence is not enabled')
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
  })

  it('one unavailable photo is marked unavailable without hiding the others', async () => {
    srv.contentErrors.set('thumb:f2', 409)
    mount(); await open()
    await waitFor(() => expect(document.querySelectorAll('img')).toHaveLength(4))
    expect(screen.getByText('Photo unavailable')).toBeInTheDocument()
  })

  it('rate limiting on a tile is recoverable with its own Retry', async () => {
    srv.contentErrors.set('thumb:f2', 429)
    mount(); await open()
    const retry = await screen.findByRole('button', { name: /Retry photo from/ })
    srv.contentErrors.delete('thumb:f2')
    await userEvent.click(retry)
    await waitFor(() => expect(document.querySelectorAll('img')).toHaveLength(5))
  })
})

describe('expired signed links', () => {
  it('a thumbnail that fails to load gets one fresh link automatically, then reports unavailable', async () => {
    srv.files = [file(1)]
    mount(); await open()
    const img = await waitFor(() => { const i = document.querySelector('img'); expect(i).toBeTruthy(); return i as HTMLImageElement })
    const first = img.getAttribute('src')
    fireEvent.error(img)
    await waitFor(() => expect(document.querySelector('img')?.getAttribute('src')).not.toBe(first))   // a new link was signed
    expect(srv.contentCalls()).toHaveLength(2)
    fireEvent.error(document.querySelector('img') as HTMLImageElement)
    expect(await screen.findByText('Photo unavailable')).toBeInTheDocument()
    expect(srv.contentCalls()).toHaveLength(2)                                                          // no retry loop
    await userEvent.click(screen.getByRole('button', { name: /Retry photo from/ }))
    await waitFor(() => expect(document.querySelector('img')).toBeTruthy())
  })

  it('SignedUrlCache reuses a link only while it has margin left, and shares one in-flight request', async () => {
    let now = 1_000_000
    const fetchContent = vi.fn(async (id: string, v: 'thumb' | 'full') => ({ url: `u-${id}-${v}-${fetchContent.mock.calls.length}`, expiresAt: new Date(now + 60_000).toISOString(), variant: v }))
    const cache = new SignedUrlCache(fetchContent, () => now, 10_000)
    const [a, b] = await Promise.all([cache.get('x', 'full'), cache.get('x', 'full')])
    expect(a).toBe(b); expect(fetchContent).toHaveBeenCalledTimes(1)
    now += 45_000
    expect(await cache.get('x', 'full')).toBe(a)                       // 15 s left: reused
    now += 10_000
    expect(await cache.get('x', 'full')).not.toBe(a)                   // 5 s left: not worth starting an image on
    expect(fetchContent).toHaveBeenCalledTimes(2)
    await cache.get('x', 'full', { fresh: true })
    expect(fetchContent).toHaveBeenCalledTimes(3)
  })

  it('a cleared cache is not repopulated by an answer that arrives late', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const fetchContent = vi.fn(async () => { await gate; return { url: 'late', expiresAt: new Date(Date.now() + 60_000).toISOString(), variant: 'full' as const } })
    const cache = new SignedUrlCache(fetchContent)
    const p = cache.get('x', 'full')
    cache.clear(); release(); await p
    await cache.get('x', 'full')
    expect(fetchContent).toHaveBeenCalledTimes(2)
  })
})

describe('lightbox', () => {
  it('opens the full-size photo with uploader and time, and moves between photos', async () => {
    mount(); await open()
    await waitFor(() => expect(document.querySelectorAll('img')).toHaveLength(5))
    await userEvent.click(screen.getAllByRole('button', { name: /Open photo from Sam Tech/ })[0])
    const dlg = await screen.findByRole('dialog', { name: 'Photo 1 of 5' })
    expect(dlg).toHaveTextContent('Uploaded by Sam Tech')
    expect(dlg).toHaveTextContent('1600×1200')
    await waitFor(() => expect(within(dlg).getByAltText(/Full size photo/)).toHaveAttribute('src', expect.stringContaining('/full/f4')))
    await userEvent.click(within(dlg).getByRole('button', { name: 'Next' }))
    expect(await screen.findByRole('dialog', { name: 'Photo 2 of 5' })).toBeInTheDocument()
    await waitFor(() => expect(within(screen.getByRole('dialog')).getByAltText(/Full size photo/)).toHaveAttribute('src', expect.stringContaining('/full/f3')))   // not the previous photo's link
    fireEvent.keyDown(within(screen.getByRole('dialog')).getByText(/Uploaded by/), { key: 'ArrowLeft' })
    expect(await screen.findByRole('dialog', { name: 'Photo 1 of 5' })).toBeInTheDocument()
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Previous' })).toBeDisabled()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('an unavailable full photo says so inside the viewer and can be retried', async () => {
    srv.files = [file(1)]
    srv.contentErrors.set('full:f1', 409)
    mount(); await open()
    await userEvent.click(await screen.findByRole('button', { name: /Open photo from/ }))
    const dlg = await screen.findByRole('dialog')
    expect(await within(dlg).findByRole('alert')).toHaveTextContent('This photo is not available right now.')
    srv.contentErrors.delete('full:f1')
    await userEvent.click(within(dlg).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(within(dlg).getByAltText(/Full size photo/)).toBeInTheDocument())
  })

  it('"Next" at the end of the loaded photos loads the next page', async () => {
    srv.files = Array.from({ length: 26 }, (_, i) => file(i)).reverse()
    mount(); await open()
    await waitFor(() => expect(document.querySelectorAll('img')).toHaveLength(24))
    await userEvent.click(screen.getAllByRole('button', { name: /Open photo from/ })[23])
    const dlg = await screen.findByRole('dialog', { name: 'Photo 24 of 24+' })
    await userEvent.click(within(dlg).getByRole('button', { name: 'Load more' }))
    await waitFor(() => expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Next' })).toBeEnabled())
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Next' }))
    expect(await screen.findByRole('dialog', { name: 'Photo 25 of 26' })).toBeInTheDocument()
  })

  it('is read-only: nothing to upload, delete or download', async () => {
    mount(); await open()
    await waitFor(() => expect(document.querySelectorAll('img')).toHaveLength(5))
    await userEvent.click(screen.getAllByRole('button', { name: /Open photo from/ })[0])
    await screen.findByRole('dialog')
    expect(screen.queryByRole('button', { name: /delete|remove|upload|download/i })).not.toBeInTheDocument()
    expect(document.querySelector('input[type=file]')).toBeNull()
    expect(document.querySelector('a[download]')).toBeNull()
  })
})

describe('access revocation', () => {
  it('losing access while browsing clears every photo and link and offers no retry', async () => {
    mount(); await open()
    await waitFor(() => expect(document.querySelectorAll('img')).toHaveLength(5))
    srv.contentErrors.set('full:f4', 403)
    await userEvent.click(screen.getAllByRole('button', { name: /Open photo from/ })[0])
    expect(await screen.findByRole('alert')).toHaveTextContent('You no longer have access to this job')
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(document.querySelectorAll('img')).toHaveLength(0)
    expect(screen.queryByRole('list', { name: /Photo thumbnails/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Try again|Retry/ })).not.toBeInTheDocument()
  })

  it('a 403 on the list (demoted manager) shows the access message and no photos', async () => {
    srv.listError = 403
    mount(); await open()
    expect(await screen.findByRole('alert')).toHaveTextContent('You no longer have access to this job')
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
    expect(document.querySelectorAll('img')).toHaveLength(0)
  })

  it('a 403 on "load more" also clears what was already shown', async () => {
    srv.files = Array.from({ length: 30 }, (_, i) => file(i)).reverse()
    mount(); await open()
    await waitFor(() => expect(document.querySelectorAll('img')).toHaveLength(24))
    srv.listError = 403
    await userEvent.click(screen.getByRole('button', { name: 'Load more photos' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('You no longer have access')
    expect(document.querySelectorAll('img')).toHaveLength(0)
  })
})

describe('workspace and job isolation', () => {
  it('every request carries the workspace and job it was opened for', async () => {
    mount({ workspaceId: 'ws-9', jobId: 'job-77' }); await open()
    await waitFor(() => expect(document.querySelectorAll('img')).toHaveLength(5))
    expect(srv.calls.length).toBeGreaterThan(1)
    for (const c of srv.calls) { expect(c).toContain('/api/ops/technician/job-77/files'); expect(c).toContain('workspaceId=ws-9') }
  })

  it('switching workspace drops the previous workspace\'s photos immediately', async () => {
    const { rerender } = mount(); await open()
    await waitFor(() => expect(document.querySelectorAll('img')).toHaveLength(5))
    rerender(<JobPhotoGallery api={srv.api as never} workspaceId="ws-2" jobId="job-1" jobLabel="J-1 · Smith St" />)
    expect(document.querySelectorAll('img')).toHaveLength(0)
    expect(screen.queryByRole('list', { name: /Photo thumbnails/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Photos' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('a slow answer for the old workspace is ignored after switching', async () => {
    let release!: () => void
    srv.listGate = new Promise<void>((r) => { release = r })
    const { rerender } = mount(); await open()
    rerender(<JobPhotoGallery api={srv.api as never} workspaceId="ws-2" jobId="job-1" jobLabel="J-1 · Smith St" />)
    srv.listGate = null
    release()
    await new Promise((r) => setTimeout(r, 30))
    expect(document.querySelectorAll('img')).toHaveLength(0)
    expect(screen.queryByRole('list', { name: /Photo thumbnails/ })).not.toBeInTheDocument()
    expect(srv.contentCalls()).toHaveLength(0)                               // no links were signed for the abandoned view
  })

  it('two Jobs on the same site have separate galleries', async () => {
    render(<>
      <JobPhotoGallery api={srv.api as never} workspaceId="ws-1" jobId="job-1" jobLabel="J-1 · Smith St" />
      <JobPhotoGallery api={srv.api as never} workspaceId="ws-1" jobId="job-2" jobLabel="J-1 · Smith St (second job)" />
    </>)
    await userEvent.click(screen.getAllByRole('button', { name: 'Photos' })[1])
    await screen.findByRole('list', { name: 'Photo thumbnails for J-1 · Smith St (second job)' })
    expect(srv.calls.every((c) => c.includes('/job-2/files'))).toBe(true)
    expect(screen.queryByRole('list', { name: 'Photo thumbnails for J-1 · Smith St' })).not.toBeInTheDocument()
  })
})

describe('classifyGalleryError', () => {
  it.each([[503, 'disabled'], [401, 'forbidden'], [403, 'forbidden'], [404, 'not_found'], [409, 'unavailable'], [410, 'unavailable'], [429, 'rate_limited'], [500, 'failed'], [undefined, 'failed']])('%s -> %s', (status, kind) => {
    expect(classifyGalleryError(status === undefined ? new Error('x') : httpErr(status))).toBe(kind)
  })
})
