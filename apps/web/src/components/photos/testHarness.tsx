// Test helpers for the photo UI: a controllable fake backend and a provider wired to the REAL upload
// engine (so the UI is tested against real queue/retry/cancel behaviour) with a fake network. Not
// imported by application code.
import React from 'react'
import { createUploadEngine, type EvidenceApi } from '../../lib/evidence/uploadEngine.js'
import { MemoryQueueStore, type QueueStore } from '../../lib/evidence/queueStore.js'
import { ImageError, type PreparedImage } from '../../lib/evidence/imagePipeline.js'
import { EVIDENCE_LIMITS } from '../../lib/evidence/limits.js'
import type { PutFn, PutOutcome } from '../../lib/evidence/uploadTransport.js'
import { attachBrowserEvents } from '../../lib/evidence/createUploader.js'
import { PhotoUploadProvider, type PhotoGuards } from './PhotoUploadProvider.js'
import type { ApiHook } from '../../hooks/useApi.js'

export const PREVIEW = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/'
export const OK: PutOutcome = { status: 200, timedOut: false, networkError: false, aborted: false }
export const NET: PutOutcome = { status: 0, timedOut: false, networkError: true, aborted: false }
export const apiErr = (status: number | undefined, message: string) => Object.assign(new Error(message), status === undefined ? {} : { status })
export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Small limits so retries and polls happen in milliseconds. */
export const FAST = { ...EVIDENCE_LIMITS, backoffBaseMs: 4, backoffCapMs: 16, pollIntervalMs: [1], pollDeadlineMs: 300, maxAttempts: 3 }

export class Backend {
  online = true
  calls: Array<{ op: string; jobId?: string; fileId?: string; body?: unknown }> = []
  files = new Map<string, { status: string }>()
  bySubmission = new Map<string, string>()
  nextInit: Array<Error | 'ok'> = []
  nextCancel: Array<Error | 'ok'> = []
  status = 'AVAILABLE'
  /** Outcomes (or deferred promises) for successive PUTs. */
  putQueue: Array<PutOutcome | (() => Promise<PutOutcome>)> = []
  puts = 0
  prepareError: ImageError | null = null
  seq = 0

  api: EvidenceApi = {
    init: async (jobId, body) => {
      this.calls.push({ op: 'init', jobId, body })
      const n = this.nextInit.shift()
      if (n instanceof Error) throw n
      let id = this.bySubmission.get(body.submissionId)
      if (!id) { id = `file-${++this.seq}`; this.bySubmission.set(body.submissionId, id); this.files.set(id, { status: 'PENDING' }) }
      return { file: { id, status: 'PENDING', kind: 'PHOTO' }, upload: { method: 'PUT' as const, url: 'https://storage.example.test/up', headers: {}, expiresAt: new Date(Date.now() + 300_000).toISOString() } }
    },
    complete: async (jobId, fileId) => { this.calls.push({ op: 'complete', jobId, fileId }); return { file: { id: fileId, status: 'PENDING', kind: 'PHOTO' }, processing: true } },
    status: async (jobId, fileId) => { this.calls.push({ op: 'status', jobId, fileId }); return { file: { status: this.status } } },
    cancel: async (jobId, fileId) => {
      this.calls.push({ op: 'cancel', jobId, fileId })
      const n = this.nextCancel.shift()
      if (n instanceof Error) throw n
      return { file: { id: fileId, status: 'REJECTED', kind: 'PHOTO' } }
    },
  }
  put: PutFn = async (a) => {
    this.puts++
    a.onProgress(a.body.size / 2, a.body.size)
    const next = this.putQueue.shift()
    return typeof next === 'function' ? next() : next ?? OK
  }
  count(op: string) { return this.calls.filter((c) => c.op === op).length }
}

let photoN = 0
export function fakePrepare(b: Backend) {
  return async (_f: Blob): Promise<PreparedImage> => {
    if (b.prepareError) throw b.prepareError
    const n = ++photoN
    return { blob: new Blob([new Uint8Array(2048 + n)], { type: 'image/jpeg' }), contentType: 'image/jpeg', sizeBytes: 2048 + n, width: 800, height: 600, sha256: String(n).padStart(64, '0'), preview: PREVIEW }
  }
}

export const fakeApiHook = (() => Promise.resolve({})) as unknown as ApiHook

type HarnessProps = {
  backend: Backend
  store?: QueueStore
  user?: { id: string } | null
  workspaceId?: string | null
  workspaceName?: string
  guardsRef?: React.MutableRefObject<PhotoGuards | null>
  children: React.ReactNode
}

/** The provider with the real engine over the fake backend. */
export function Harness({ backend, store, user = { id: 'user-a' }, workspaceId = 'ws-1', workspaceName = 'Acme Plumbing', guardsRef, children }: HarnessProps) {
  const st = React.useMemo(() => store ?? new MemoryQueueStore(), [store])
  return (
    <PhotoUploadProvider
      user={user} workspaceId={workspaceId} workspaceName={workspaceName} api={fakeApiHook} store={st} guardsRef={guardsRef}
      makeEngine={({ scope, sessionUserId, store: s }) => createUploadEngine({
        scope, store: s, api: backend.api, put: backend.put, prepare: fakePrepare(backend), sessionUserId,
        isOnline: () => backend.online, limits: FAST, random: () => 0.5, attach: attachBrowserEvents,
      })}
    >
      {children}
    </PhotoUploadProvider>
  )
}
