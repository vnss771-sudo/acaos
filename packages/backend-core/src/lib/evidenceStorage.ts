// Provider-neutral object storage for evidence files. The rest of the code talks
// to `EvidenceObjectStore`; only createS3EvidenceStore knows it is an S3-compatible
// service, and which vendor sits behind the endpoint is configuration.
import { randomBytes, createHash } from 'node:crypto'
import {
  S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand, DeleteObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { Readable } from 'node:stream'
import type { EvidenceStorageConfig } from './evidenceStorageConfig.js'

/** What the S3 adapter needs; the backup store reuses it with its own credentials. */
export type S3ConnectionConfig = Pick<EvidenceStorageConfig, 'endpoint' | 'bucket' | 'region' | 'accessKeyId' | 'secretAccessKey' | 'forcePathStyle'>

export class EvidenceObjectTooLargeError extends Error {
  constructor(public readonly maxBytes: number) { super(`object exceeds ${maxBytes} bytes`); this.name = 'EvidenceObjectTooLargeError' }
}

export type SignedUpload = { url: string; headers: Record<string, string> }

export interface EvidenceObjectStore {
  /** A short-lived PUT URL bound to this exact key, content type and byte length. */
  presignPut(o: { key: string; contentType: string; contentLength: number; expiresInSeconds: number }): Promise<SignedUpload>
  /** Object metadata, or null if it does not exist. */
  head(key: string): Promise<{ size: number } | null>
  /** The object's bytes (null if missing). Throws EvidenceObjectTooLargeError past maxBytes. */
  getBytes(key: string, maxBytes: number): Promise<Buffer | null>
  /** Like getBytes, plus the object's ETag so a later write can be conditional on "unchanged since I read it". */
  getBytesWithEtag(key: string, maxBytes: number): Promise<{ bytes: Buffer; etag: string } | null>
  putBytes(key: string, body: Buffer, contentType: string): Promise<void>
  /**
   * Write only if the precondition holds: `ifNoneMatch` = the key must not exist,
   * `ifMatch` = the object must still have this ETag. Used by restore so it can never
   * overwrite an object that appeared or changed after it looked. Relies on the
   * provider enforcing S3 conditional writes (verified against the real service in the
   * drill; a provider that ignores the headers would silently weaken this).
   */
  putBytesIf(key: string, body: Buffer, contentType: string, cond: { ifNoneMatch: true } | { ifMatch: string }): Promise<'written' | 'precondition_failed'>
  /** Idempotent: deleting a missing object succeeds. */
  delete(key: string): Promise<void>
}

// ── keys ────────────────────────────────────────────────────────────────────
// Keys are ws/<workspaceId>/job/<jobId>/<kind>/<192 random bits>. The random part
// makes them unguessable; the prefix is also enforced by a CHECK constraint on
// EvidenceFileCopy, and by assertKeyInWorkspace before any storage call.

export function newEvidenceKeys(workspaceId: string, jobId: string): { uploadKey: string; primaryKey: string } {
  const base = `ws/${workspaceId}/job/${jobId}`
  return {
    uploadKey: `${base}/upload/${randomBytes(24).toString('base64url')}`,
    primaryKey: `${base}/final/${randomBytes(24).toString('base64url')}`,
  }
}

/** Stricter than assertKeyInWorkspace: the key must sit under this exact workspace AND job. */
export function assertKeyForJob(key: string, workspaceId: string, jobId: string): void {
  assertKeyInWorkspace(key, workspaceId)
  if (!key.startsWith(`ws/${workspaceId}/job/${jobId}/`)) throw new Error('object key does not belong to this job')
}

export function assertKeyInWorkspace(key: string, workspaceId: string): void {
  if (!key.startsWith(`ws/${workspaceId}/`) || key.includes('..') || key.includes('//')) {
    throw new Error('object key does not belong to this workspace')
  }
}

// ── S3-compatible implementation ────────────────────────────────────────────

// `send` lets tests drive head/get/put/delete with a fake instead of the network;
// presigning is a local computation and always uses the real client.
export function createS3EvidenceStore(
  cfg: S3ConnectionConfig,
  deps: { send?: (cmd: unknown) => Promise<unknown> } = {},
): EvidenceObjectStore {
  const client = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    forcePathStyle: cfg.forcePathStyle,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    maxAttempts: 3,
    // Non-AWS S3-compatible services do not all accept the SDK's default CRC32 trailer.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  })
  const Bucket = cfg.bucket
  const send = (cmd: unknown) => (deps.send ? deps.send(cmd) : client.send(cmd as never))
  const isMissing = (e: unknown) => {
    const x = e as { name?: string; $metadata?: { httpStatusCode?: number } }
    return x?.name === 'NotFound' || x?.name === 'NoSuchKey' || x?.$metadata?.httpStatusCode === 404
  }
  return {
    async presignPut({ key, contentType, contentLength, expiresInSeconds }) {
      const cmd = new PutObjectCommand({ Bucket, Key: key, ContentType: contentType, ContentLength: contentLength })
      // Signing content-type and content-length means the storage service rejects a
      // body of any other size or type, so the declared size is enforced at upload time.
      const url = await getSignedUrl(client, cmd, {
        expiresIn: expiresInSeconds,
        signableHeaders: new Set(['content-type', 'content-length']),
      })
      return { url, headers: { 'Content-Type': contentType, 'Content-Length': String(contentLength) } }
    },
    async head(key) {
      try {
        const r = (await send(new HeadObjectCommand({ Bucket, Key: key }))) as { ContentLength?: number }
        return { size: Number(r.ContentLength ?? 0) }
      } catch (e) {
        if (isMissing(e)) return null
        throw e
      }
    },
    async getBytesWithEtag(key, maxBytes) {
      let r: { ContentLength?: number; Body?: unknown; ETag?: string }
      try {
        r = (await send(new GetObjectCommand({ Bucket, Key: key }))) as { ContentLength?: number; Body?: unknown; ETag?: string }
      } catch (e) {
        if (isMissing(e)) return null
        throw e
      }
      if (typeof r.ContentLength === 'number' && r.ContentLength > maxBytes) throw new EvidenceObjectTooLargeError(maxBytes)
      const chunks: Buffer[] = []
      let total = 0
      for await (const chunk of r.Body as Readable) {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        total += b.length
        if (total > maxBytes) throw new EvidenceObjectTooLargeError(maxBytes)
        chunks.push(b)
      }
      return { bytes: Buffer.concat(chunks), etag: r.ETag ?? '' }
    },
    async getBytes(key, maxBytes) {
      return (await this.getBytesWithEtag(key, maxBytes))?.bytes ?? null
    },
    async putBytesIf(key, body, contentType, cond) {
      try {
        await send(new PutObjectCommand({
          Bucket, Key: key, Body: body, ContentType: contentType, ContentLength: body.length,
          ...('ifNoneMatch' in cond ? { IfNoneMatch: '*' } : { IfMatch: cond.ifMatch }),
        }))
        return 'written'
      } catch (e) {
        const x = e as { name?: string; $metadata?: { httpStatusCode?: number } }
        // 412 = precondition failed; 409 = a concurrent conditional write is in flight.
        if (x?.name === 'PreconditionFailed' || x?.$metadata?.httpStatusCode === 412 || x?.$metadata?.httpStatusCode === 409) return 'precondition_failed'
        throw e
      }
    },
    async putBytes(key, body, contentType) {
      await send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: contentType, ContentLength: body.length }))
    },
    async delete(key) {
      await send(new DeleteObjectCommand({ Bucket, Key: key }))
    },
  }
}

// ── in-memory implementation (tests) ────────────────────────────────────────
// Mirrors what the real service enforces for a presigned PUT, so security tests
// can show a forged size, type or expired URL being refused without any network.

type Signed = { key: string; contentType: string; contentLength: number; expiresAt: number }

export class MemoryEvidenceStore implements EvidenceObjectStore {
  readonly objects = new Map<string, { bytes: Buffer; contentType: string }>()
  private readonly signed = new Map<string, Signed>()
  failNext: { op: 'head' | 'getBytes' | 'putBytes' | 'delete'; times: number } | null = null
  calls: string[] = []
  /** Runs after an object is stored by putBytes (tests use it to inject a concurrent event). */
  onPut: ((key: string) => Promise<void> | void) | null = null
  now: () => number = () => Date.now()

  private maybeFail(op: 'head' | 'getBytes' | 'putBytes' | 'delete') {
    this.calls.push(op)
    if (this.failNext && this.failNext.op === op && this.failNext.times > 0) {
      this.failNext.times--
      throw new Error(`injected ${op} failure`)
    }
  }
  async presignPut(o: { key: string; contentType: string; contentLength: number; expiresInSeconds: number }): Promise<SignedUpload> {
    const url = `memory://put/${randomBytes(12).toString('hex')}`
    this.signed.set(url, { key: o.key, contentType: o.contentType, contentLength: o.contentLength, expiresAt: this.now() + o.expiresInSeconds * 1000 })
    return { url, headers: { 'Content-Type': o.contentType, 'Content-Length': String(o.contentLength) } }
  }
  /** What the client's HTTP PUT would do against the real service. */
  clientPut(url: string, bytes: Buffer, headers: Record<string, string>): { status: number } {
    const s = this.signed.get(url)
    if (!s) return { status: 403 }
    if (this.now() > s.expiresAt) return { status: 403 }
    if (headers['Content-Type'] !== s.contentType) return { status: 403 }
    if (bytes.length !== s.contentLength || Number(headers['Content-Length']) !== s.contentLength) return { status: 403 }
    this.objects.set(s.key, { bytes, contentType: s.contentType })
    return { status: 200 }
  }
  async head(key: string) {
    this.maybeFail('head')
    const o = this.objects.get(key)
    return o ? { size: o.bytes.length } : null
  }
  async getBytes(key: string, maxBytes: number) {
    this.maybeFail('getBytes')
    const o = this.objects.get(key)
    if (!o) return null
    if (o.bytes.length > maxBytes) throw new EvidenceObjectTooLargeError(maxBytes)
    return Buffer.from(o.bytes)
  }
  private etags = new Map<string, string>()
  private version = 0
  private etagOf(key: string): string | null {
    const o = this.objects.get(key)
    if (!o) return null
    // Any change to the stored bytes yields a new ETag (tests assign to .objects directly).
    const sig = `${o.bytes.length}:${createHash('md5').update(o.bytes).digest('hex')}`
    const prev = this.etags.get(key)
    if (prev && prev.startsWith(`${sig}:`)) return prev
    const next = `${sig}:${++this.version}`
    this.etags.set(key, next)
    return next
  }
  /** Runs between a conditional write's precondition check and the write (tests inject a racing writer here). */
  beforeConditionalWrite: ((key: string) => Promise<void> | void) | null = null
  async getBytesWithEtag(key: string, maxBytes: number) {
    this.maybeFail('getBytes')
    const o = this.objects.get(key)
    if (!o) return null
    if (o.bytes.length > maxBytes) throw new EvidenceObjectTooLargeError(maxBytes)
    return { bytes: Buffer.from(o.bytes), etag: this.etagOf(key) as string }
  }
  async putBytesIf(key: string, body: Buffer, contentType: string, cond: { ifNoneMatch: true } | { ifMatch: string }) {
    this.maybeFail('putBytes')
    this.conditionalAttempts++
    if (this.beforeConditionalWrite) await this.beforeConditionalWrite(key)
    // The check and the write below are synchronous, like a provider's atomic conditional put.
    const exists = this.objects.has(key)
    const ok = 'ifNoneMatch' in cond ? !exists : exists && this.etagOf(key) === cond.ifMatch
    if (!ok) return 'precondition_failed' as const
    this.objects.set(key, { bytes: Buffer.from(body), contentType })
    if (this.onPut) await this.onPut(key)
    return 'written' as const
  }
  conditionalAttempts = 0
  async putBytes(key: string, body: Buffer, contentType: string) {
    this.maybeFail('putBytes')
    this.objects.set(key, { bytes: Buffer.from(body), contentType })
    if (this.onPut) await this.onPut(key)
  }
  async delete(key: string) {
    this.maybeFail('delete')
    this.objects.delete(key)
  }
}

// ── accessor ────────────────────────────────────────────────────────────────

let override: EvidenceObjectStore | null = null
let cached: { id: string; store: EvidenceObjectStore } | null = null

/** Tests inject a store here. Refused in production so it can never mask a real bucket. */
export function setEvidenceStoreForTests(store: EvidenceObjectStore | null): void {
  if (process.env.NODE_ENV === 'production') throw new Error('setEvidenceStoreForTests is not available in production')
  override = store
}

let backupOverride: EvidenceObjectStore | null = null
let backupCached: { id: string; store: EvidenceObjectStore } | null = null

/** Tests inject the backup store here. Refused in production. */
export function setEvidenceBackupStoreForTests(store: EvidenceObjectStore | null): void {
  if (process.env.NODE_ENV === 'production') throw new Error('setEvidenceBackupStoreForTests is not available in production')
  backupOverride = store
}

export function getEvidenceBackupStore(cfg: S3ConnectionConfig): EvidenceObjectStore {
  if (backupOverride) return backupOverride
  const id = `${cfg.endpoint}|${cfg.bucket}|${cfg.accessKeyId}|${cfg.region}`
  if (!backupCached || backupCached.id !== id) backupCached = { id, store: createS3EvidenceStore(cfg) }
  return backupCached.store
}

export function getEvidenceStore(cfg: EvidenceStorageConfig): EvidenceObjectStore {
  if (override) return override
  const id = `${cfg.endpoint}|${cfg.bucket}|${cfg.accessKeyId}|${cfg.region}|${cfg.forcePathStyle}`
  if (!cached || cached.id !== id) cached = { id, store: createS3EvidenceStore(cfg) }
  return cached.store
}
