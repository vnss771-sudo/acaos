// External deletion ledger (C4). An append-only record of evidence deletions, legal
// holds and workspace erasures kept OUTSIDE PostgreSQL, so that restoring an older
// database backup cannot silently resurrect evidence that was lawfully deleted (or
// lose a legal hold). The deletion runner reconciles the database against it.
//
// Design, and what is and is not claimed:
//  - Every entry is written create-only (If-None-Match) under a key that is never
//    reused; each carries an HMAC so entries forged by someone who only has write
//    access to the bucket are ignored (a ledger entry can cause deletion on
//    reconcile, so it must be unforgeable without the MAC key).
//  - Per workspace there is also a hash chain (seq/000000000001, ...): each entry
//    includes the SHA-256 of the previous one. A removed or altered entry is detectable
//    (verifyLedgerChain) but removal of the newest entries is not, without an external
//    anchor.
//  - "Write-once" is a property of the PROVIDER and the credential, not of this code.
//    probeLedgerImmutability() measures what the configured credential can actually do
//    (second create, overwrite, delete) and the deletion runner refuses to run unless
//    the result is 'enforced'. Passing the probe shows this credential cannot
//    overwrite or delete; it does not prove the provider's account owner cannot.
import { createHash, createHmac, randomBytes } from 'node:crypto'
import type { EvidenceObjectStore } from './evidenceStorage.js'

export type LedgerEntry =
  | {
      type: 'FILE_DELETION_STARTED'; workspaceId: string; fileId: string; jobId: string; requestId: string
      sha256: string; sizeBytes: number | null; primaryKey: string; backupKey: string | null
      requestedBy: string; reviewedBy: string; approvedAt: string; notBefore: string; at: string
    }
  | { type: 'FILE_DELETION_COMPLETED'; workspaceId: string; fileId: string; requestId: string; at: string }
  | { type: 'HOLD_PLACED'; workspaceId: string; holdId: string; scope: string; jobId: string | null; placedBy: string; at: string }
  | { type: 'HOLD_RELEASED'; workspaceId: string; holdId: string; releasedBy: string; at: string }
  | { type: 'WORKSPACE_ERASED'; workspaceId: string; erasedBy: string; fileCount: number; at: string }

type Envelope = { v: 1; seq: number; prevHash: string; entry: LedgerEntry; mac: string }

const GENESIS = '0'.repeat(64)
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')

/** JSON with sorted keys, so a MAC / equality does not depend on property order. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`
  }
  return JSON.stringify(v)
}

const macOf = (key: string, e: Omit<Envelope, 'mac'>) => createHmac('sha256', key).update(canonicalJson(e)).digest('hex')
const sameLogical = (a: LedgerEntry, b: LedgerEntry) => {
  const { at: _a, ...x } = a as Record<string, unknown>; const { at: _b, ...y } = b as Record<string, unknown>
  void _a; void _b
  return canonicalJson(x) === canonicalJson(y)
}

export class LedgerError extends Error {
  constructor(public readonly code: 'conflict' | 'unavailable' | 'invalid', message: string) { super(message); this.name = 'LedgerError' }
}

const base = (ws: string) => `v1/ws/${ws}`
const seqKey = (ws: string, n: number) => `${base(ws)}/seq/${String(n).padStart(12, '0')}`
export function semanticKey(e: LedgerEntry): string {
  const b = base(e.workspaceId)
  switch (e.type) {
    case 'FILE_DELETION_STARTED': return `${b}/file/${e.fileId}/started`
    case 'FILE_DELETION_COMPLETED': return `${b}/file/${e.fileId}/completed`
    case 'HOLD_PLACED': return `${b}/hold/${e.holdId}/placed`
    case 'HOLD_RELEASED': return `${b}/hold/${e.holdId}/released`
    case 'WORKSPACE_ERASED': return `${b}/erased`
  }
}

export class EvidenceLedger {
  constructor(private readonly store: EvidenceObjectStore, private readonly macKey: string) {}

  private async read(key: string): Promise<{ env: Envelope; raw: Buffer } | null> {
    const raw = await this.store.getBytes(key, 64 * 1024)
    if (!raw) return null
    try {
      const env = JSON.parse(raw.toString('utf8')) as Envelope
      const { mac, ...rest } = env
      if (env.v !== 1 || typeof mac !== 'string' || macOf(this.macKey, rest) !== mac) throw new Error('bad mac')
      return { env, raw }
    } catch {
      throw new LedgerError('invalid', `ledger entry ${key} failed authentication`)
    }
  }

  /** The entry at its semantic key, or null. Throws LedgerError('invalid') if it fails its MAC. */
  async get(key: string): Promise<LedgerEntry | null> {
    return (await this.read(key))?.env.entry ?? null
  }

  private async lastSeq(ws: string): Promise<{ seq: number; hash: string }> {
    let last: string | undefined
    let startAfter: string | undefined
    for (;;) {
      const page = await this.store.list(`${base(ws)}/seq/`, { limit: 1000, startAfter })
      if (!page.length) break
      last = page[page.length - 1]
      if (page.length < 1000) break
      startAfter = last
    }
    if (!last) return { seq: 0, hash: GENESIS }
    const r = await this.read(last)
    return { seq: Number(last.slice(last.lastIndexOf('/') + 1)), hash: sha256(r!.raw) }
  }

  /**
   * Append an entry. Idempotent: if the same logical entry already exists at its
   * semantic key it is returned unchanged; a DIFFERENT entry at that key is a conflict.
   */
  async append(entry: LedgerEntry): Promise<{ key: string; existing: boolean }> {
    const key = semanticKey(entry)
    const have = await this.read(key)
    if (have) {
      if (sameLogical(have.env.entry, entry)) return { key, existing: true }
      throw new LedgerError('conflict', `ledger already holds a different entry at ${key}`)
    }
    let env: Envelope | null = null
    for (let attempt = 0; attempt < 40 && !env; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 15)))   // de-synchronise contending appenders
      const { seq, hash } = await this.lastSeq(entry.workspaceId)
      const rest = { v: 1 as const, seq: seq + 1, prevHash: hash, entry }
      const candidate: Envelope = { ...rest, mac: macOf(this.macKey, rest) }
      const won = await this.store.putBytesIf(seqKey(entry.workspaceId, seq + 1), Buffer.from(JSON.stringify(candidate)), 'application/json', { ifNoneMatch: true })
      if (won === 'written') env = candidate
    }
    if (!env) throw new LedgerError('unavailable', 'could not allocate a ledger sequence number')
    const wrote = await this.store.putBytesIf(key, Buffer.from(JSON.stringify(env)), 'application/json', { ifNoneMatch: true })
    if (wrote === 'precondition_failed') {
      const now = await this.read(key)
      if (!now || !sameLogical(now.env.entry, entry)) throw new LedgerError('conflict', `ledger already holds a different entry at ${key}`)
      return { key, existing: true }
    }
    return { key, existing: false }
  }

  /** Per-file deletion state from the ledger. Forged entries (bad MAC) are reported, never trusted. */
  async fileStates(ws: string): Promise<{ states: Map<string, { started?: Extract<LedgerEntry, { type: 'FILE_DELETION_STARTED' }>; completed?: boolean }>; invalid: string[] }> {
    const states = new Map<string, { started?: Extract<LedgerEntry, { type: 'FILE_DELETION_STARTED' }>; completed?: boolean }>()
    const invalid: string[] = []
    const prefix = `${base(ws)}/file/`
    let startAfter: string | undefined
    for (;;) {
      const keys = await this.store.list(prefix, { limit: 1000, startAfter })
      for (const k of keys) {
        const [fileId, which] = k.slice(prefix.length).split('/')
        if (!fileId || (which !== 'started' && which !== 'completed')) continue
        try {
          const e = await this.get(k)
          if (!e) continue
          const st = states.get(fileId) ?? {}
          if (which === 'started' && e.type === 'FILE_DELETION_STARTED' && e.fileId === fileId && e.workspaceId === ws) st.started = e
          else if (which === 'completed' && e.type === 'FILE_DELETION_COMPLETED' && e.fileId === fileId && e.workspaceId === ws) st.completed = true
          else { invalid.push(k); continue }
          states.set(fileId, st)
        } catch { invalid.push(k) }
      }
      if (keys.length < 1000) break
      startAfter = keys[keys.length - 1]
    }
    return { states, invalid }
  }

  async holdStates(ws: string): Promise<{ holds: Map<string, { placed?: Extract<LedgerEntry, { type: 'HOLD_PLACED' }>; released?: boolean }>; invalid: string[] }> {
    const holds = new Map<string, { placed?: Extract<LedgerEntry, { type: 'HOLD_PLACED' }>; released?: boolean }>()
    const invalid: string[] = []
    const prefix = `${base(ws)}/hold/`
    for (const k of await this.store.list(prefix, { limit: 10_000 })) {
      const [holdId, which] = k.slice(prefix.length).split('/')
      try {
        const e = await this.get(k)
        if (!e || !holdId) continue
        const st = holds.get(holdId) ?? {}
        if (which === 'placed' && e.type === 'HOLD_PLACED' && e.holdId === holdId && e.workspaceId === ws) st.placed = e
        else if (which === 'released' && e.type === 'HOLD_RELEASED' && e.holdId === holdId && e.workspaceId === ws) st.released = true
        else { invalid.push(k); continue }
        holds.set(holdId, st)
      } catch { invalid.push(k) }
    }
    return { holds, invalid }
  }

  async isErased(ws: string): Promise<boolean> {
    return (await this.get(`${base(ws)}/erased`).catch(() => null))?.type === 'WORKSPACE_ERASED'
  }

  /** Check the per-workspace hash chain: contiguous sequence, valid MACs, correct links. */
  async verifyChain(ws: string): Promise<{ ok: boolean; entries: number; problems: string[] }> {
    const problems: string[] = []
    const keys: string[] = []
    let startAfter: string | undefined
    for (;;) {
      const page = await this.store.list(`${base(ws)}/seq/`, { limit: 1000, startAfter })
      keys.push(...page)
      if (page.length < 1000) break
      startAfter = page[page.length - 1]
    }
    let prev = GENESIS
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]
      if (k !== seqKey(ws, i + 1)) { problems.push(`gap or unexpected key before ${k}`); break }
      try {
        const r = await this.read(k)
        if (!r) { problems.push(`missing ${k}`); break }
        if (r.env.seq !== i + 1) problems.push(`${k}: wrong seq`)
        if (r.env.prevHash !== prev) problems.push(`${k}: broken link`)
        prev = sha256(r.raw)
      } catch { problems.push(`${k}: failed authentication`); break }
    }
    return { ok: problems.length === 0, entries: keys.length, problems }
  }
}

// ── immutability probe ──────────────────────────────────────────────────────

export type LedgerProbe = {
  createOnly: boolean       // a second create-only write to the same key is refused
  overwriteDenied: boolean  // an unconditional overwrite is refused (or has no effect)
  deleteDenied: boolean     // the object is still there after a delete attempt
  level: 'enforced' | 'create_only' | 'none'
}

/**
 * Measure what the ledger credential can actually do to an existing object. Leaves at
 * most one tiny probe object under `v1/_probe/` (exactly when immutability holds).
 */
export async function probeLedgerImmutability(store: EvidenceObjectStore): Promise<LedgerProbe> {
  const key = `v1/_probe/${Date.now()}-${randomBytes(8).toString('hex')}`
  const original = Buffer.from('ledger-probe-original')
  if ((await store.putBytesIf(key, original, 'text/plain', { ifNoneMatch: true })) !== 'written') {
    return { createOnly: false, overwriteDenied: false, deleteDenied: false, level: 'none' }
  }
  const createOnly = (await store.putBytesIf(key, Buffer.from('ledger-probe-second'), 'text/plain', { ifNoneMatch: true })) === 'precondition_failed'
  let overwriteDenied = false
  try { await store.putBytes(key, Buffer.from('ledger-probe-overwrite'), 'text/plain') } catch { overwriteDenied = true }
  if (!overwriteDenied) overwriteDenied = (await store.getBytes(key, 1024))?.equals(original) === true
  try { await store.delete(key) } catch { /* denied is the good outcome */ }
  const deleteDenied = (await store.head(key)) !== null
  const level = createOnly && overwriteDenied && deleteDenied ? 'enforced' : createOnly ? 'create_only' : 'none'
  return { createOnly, overwriteDenied, deleteDenied, level }
}

export class LedgerNotTrustedError extends Error {
  constructor(public readonly probe: LedgerProbe) { super(`ledger is not provably immutable (level: ${probe.level})`); this.name = 'LedgerNotTrustedError' }
}

/** Throws unless the ledger credential is provably unable to overwrite or delete (or the dev override is set). */
export async function assertLedgerTrusted(store: EvidenceObjectStore, opts: { allowUnenforced?: boolean } = {}): Promise<LedgerProbe> {
  const probe = await probeLedgerImmutability(store)
  if (probe.level === 'enforced') return probe
  if (opts.allowUnenforced && probe.level === 'create_only') return probe
  throw new LedgerNotTrustedError(probe)
}
