// Configuration for evidence governance and controlled deletion (C4). Like uploads
// and backups, everything FAILS CLOSED, and destructive operations sit behind their
// OWN flag, separate from the upload and backup flags.
//
// Three independent concerns:
//
//  1. External deletion ledger (EVIDENCE_LEDGER_*): an append-only record kept OUTSIDE
//     PostgreSQL so a database restore cannot silently resurrect deleted evidence.
//     Used by the API (holds, erasure; append/read) and the deletion runner. It is a
//     third store: its own bucket, its own credentials.
//       EVIDENCE_LEDGER_ENABLED            "true" to enable
//       EVIDENCE_LEDGER_ENDPOINT           https R2 account host (loopback http outside production)
//       EVIDENCE_LEDGER_BUCKET             must differ from the primary and backup buckets
//       EVIDENCE_LEDGER_ACCESS_KEY_ID      create/read ONLY (no overwrite, no delete) - see probe
//       EVIDENCE_LEDGER_SECRET_ACCESS_KEY
//       EVIDENCE_LEDGER_REGION             default "auto"
//       EVIDENCE_LEDGER_MAC_KEY            >= 32 chars; signs entries so a forged one is ignored
//
//  2. Deletion workflow (request/approve endpoints): EVIDENCE_DESTRUCTIVE_ENABLED must be
//     exactly "true" and EVIDENCE_DELETION_SEAL_KEY (>= 32 chars) set. The seal key signs
//     approvals; whoever cannot hold it cannot forge one. No delete credentials needed.
//
//  3. Deletion runner (the only process that deletes evidence objects): additionally
//     needs separate delete-capable credentials for the primary and backup buckets:
//       EVIDENCE_DELETE_PRIMARY_ACCESS_KEY_ID / _SECRET_ACCESS_KEY
//       EVIDENCE_DELETE_BACKUP_ACCESS_KEY_ID  / _SECRET_ACCESS_KEY
//     Endpoints and buckets are the same variables as the upload/backup configuration
//     (EVIDENCE_S3_ENDPOINT/BUCKET, EVIDENCE_BACKUP_ENDPOINT/BUCKET). These credentials
//     must differ from the normal ones, and the upload and backup resolvers disable
//     their service if any EVIDENCE_DELETE_* variable is present in it.
import { R2_HOST } from './evidenceBackupConfig.js'
import type { S3ConnectionConfig } from './evidenceStorage.js'

type Env = Record<string, string | undefined>

export type EvidenceLedgerConfig = S3ConnectionConfig & { macKey: string }
export type EvidenceLedgerState =
  | { enabled: true; config: EvidenceLedgerConfig }
  | { enabled: false; reason: 'flag_off' | 'invalid_config'; problems: string[] }

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/
const hostOf = (url: string | undefined) => { try { return url ? new URL(url).host.toLowerCase() : '' } catch { return '' } }

function endpointProblem(url: string, label: string, r2Only: boolean, env: Env): string | null {
  try {
    const u = new URL(url)
    const production = env.NODE_ENV === 'production'
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
    if (u.username || u.password) return `${label} must not embed credentials`
    if (u.pathname !== '/' && u.pathname !== '') return `${label} must not include a path`
    if (u.protocol === 'https:' && (!r2Only || R2_HOST.test(u.hostname.toLowerCase()))) return null
    if (u.protocol === 'http:' && loopback && !production) return null
    return r2Only ? `${label} must be an https Cloudflare R2 account endpoint` : `${label} must be an https URL`
  } catch {
    return `${label} is not a valid URL`
  }
}

export function resolveEvidenceLedger(env: Env = process.env): EvidenceLedgerState {
  const flag = env.EVIDENCE_LEDGER_ENABLED?.trim().toLowerCase()
  if (!flag || flag === 'false') return { enabled: false, reason: 'flag_off', problems: [] }
  if (flag !== 'true') return { enabled: false, reason: 'invalid_config', problems: ['EVIDENCE_LEDGER_ENABLED must be "true" or "false"'] }
  const problems: string[] = []
  const need = (k: string) => { const v = env[k]?.trim(); if (!v) problems.push(`${k} is required`); return v ?? '' }
  const endpoint = need('EVIDENCE_LEDGER_ENDPOINT')
  const bucket = need('EVIDENCE_LEDGER_BUCKET')
  const accessKeyId = need('EVIDENCE_LEDGER_ACCESS_KEY_ID')
  const secretAccessKey = need('EVIDENCE_LEDGER_SECRET_ACCESS_KEY')
  const macKey = env.EVIDENCE_LEDGER_MAC_KEY?.trim() ?? ''
  if (macKey.length < 32) problems.push('EVIDENCE_LEDGER_MAC_KEY must be at least 32 characters')
  if (endpoint) { const p = endpointProblem(endpoint, 'EVIDENCE_LEDGER_ENDPOINT', true, env); if (p) problems.push(p) }
  if (bucket && !BUCKET.test(bucket)) problems.push('EVIDENCE_LEDGER_BUCKET is not a valid bucket name')

  // Independence: its own bucket and credentials; never one of the evidence stores.
  const host = hostOf(endpoint)
  for (const [label, ep, bk, key] of [
    ['primary', env.EVIDENCE_S3_ENDPOINT, env.EVIDENCE_S3_BUCKET, env.EVIDENCE_S3_ACCESS_KEY_ID],
    ['backup', env.EVIDENCE_BACKUP_ENDPOINT, env.EVIDENCE_BACKUP_BUCKET, env.EVIDENCE_BACKUP_ACCESS_KEY_ID],
  ] as const) {
    if (bucket && bk?.trim() === bucket && (!ep || !host || hostOf(ep) === host)) problems.push(`EVIDENCE_LEDGER_BUCKET must differ from the ${label} bucket`)
    if (accessKeyId && key?.trim() === accessKeyId) problems.push(`ledger credentials must differ from the ${label} credentials`)
  }
  if (problems.length) return { enabled: false, reason: 'invalid_config', problems }
  return { enabled: true, config: { endpoint, bucket, accessKeyId, secretAccessKey, region: env.EVIDENCE_LEDGER_REGION?.trim() || 'auto', forcePathStyle: false, macKey } }
}

// ── workflow (API) ──────────────────────────────────────────────────────────

export type DeletionWorkflowState =
  | { enabled: true; sealKey: string }
  | { enabled: false; reason: 'flag_off' | 'invalid_config'; problems: string[] }

/** May deletion requests be created and approved? Needs the destructive flag and the seal key. */
export function resolveDeletionWorkflow(env: Env = process.env): DeletionWorkflowState {
  const flag = env.EVIDENCE_DESTRUCTIVE_ENABLED?.trim().toLowerCase()
  if (!flag || flag === 'false') return { enabled: false, reason: 'flag_off', problems: [] }
  if (flag !== 'true') return { enabled: false, reason: 'invalid_config', problems: ['EVIDENCE_DESTRUCTIVE_ENABLED must be "true" or "false"'] }
  const key = env.EVIDENCE_DELETION_SEAL_KEY?.trim() ?? ''
  if (key.length < 32) return { enabled: false, reason: 'invalid_config', problems: ['EVIDENCE_DELETION_SEAL_KEY must be at least 32 characters'] }
  return { enabled: true, sealKey: key }
}

// ── runner ──────────────────────────────────────────────────────────────────

export type EvidenceDeletionConfig = {
  primary: S3ConnectionConfig
  backup: S3ConnectionConfig
  ledger: EvidenceLedgerConfig
  sealKey: string
  /** Dev/test only: accept a ledger that is create-only but not provably immutable. Refused in production. */
  allowUnenforcedLedger: boolean
}
export type EvidenceDeletionState =
  | { enabled: true; config: EvidenceDeletionConfig }
  | { enabled: false; reason: 'flag_off' | 'invalid_config'; problems: string[] }

export function resolveEvidenceDeletion(env: Env = process.env): EvidenceDeletionState {
  const wf = resolveDeletionWorkflow(env)
  if (!wf.enabled) return wf
  const problems: string[] = []
  const ledger = resolveEvidenceLedger(env)
  if (!ledger.enabled) problems.push(...(ledger.reason === 'flag_off' ? ['EVIDENCE_LEDGER_ENABLED must be "true" for deletion'] : ledger.problems))
  const need = (k: string) => { const v = env[k]?.trim(); if (!v) problems.push(`${k} is required`); return v ?? '' }
  const pEndpoint = need('EVIDENCE_S3_ENDPOINT'); const pBucket = need('EVIDENCE_S3_BUCKET')
  const bEndpoint = need('EVIDENCE_BACKUP_ENDPOINT'); const bBucket = need('EVIDENCE_BACKUP_BUCKET')
  const pKey = need('EVIDENCE_DELETE_PRIMARY_ACCESS_KEY_ID'); const pSecret = need('EVIDENCE_DELETE_PRIMARY_SECRET_ACCESS_KEY')
  const bKey = need('EVIDENCE_DELETE_BACKUP_ACCESS_KEY_ID'); const bSecret = need('EVIDENCE_DELETE_BACKUP_SECRET_ACCESS_KEY')
  if (pEndpoint) { const p = endpointProblem(pEndpoint, 'EVIDENCE_S3_ENDPOINT', false, env); if (p) problems.push(p) }
  if (bEndpoint) { const p = endpointProblem(bEndpoint, 'EVIDENCE_BACKUP_ENDPOINT', true, env); if (p) problems.push(p) }
  for (const [k, v] of [['EVIDENCE_S3_BUCKET', pBucket], ['EVIDENCE_BACKUP_BUCKET', bBucket]] as const) if (v && !BUCKET.test(v)) problems.push(`${k} is not a valid bucket name`)

  // The delete tokens must be dedicated: distinct from each other, from the normal
  // upload/backup/ledger credentials, so no write-path service can delete evidence.
  const keys = [pKey, bKey].filter(Boolean)
  if (new Set(keys).size !== keys.length) problems.push('primary and backup delete credentials must differ')
  for (const [label, k] of [['EVIDENCE_S3_ACCESS_KEY_ID', env.EVIDENCE_S3_ACCESS_KEY_ID], ['EVIDENCE_BACKUP_ACCESS_KEY_ID', env.EVIDENCE_BACKUP_ACCESS_KEY_ID], ['EVIDENCE_LEDGER_ACCESS_KEY_ID', env.EVIDENCE_LEDGER_ACCESS_KEY_ID]] as const) {
    const v = k?.trim(); if (v && keys.includes(v)) problems.push(`delete credentials must differ from ${label}`)
  }
  const allowUnenforcedLedger = env.EVIDENCE_LEDGER_ALLOW_UNENFORCED?.trim().toLowerCase() === 'true'
  if (allowUnenforcedLedger && env.NODE_ENV === 'production') problems.push('EVIDENCE_LEDGER_ALLOW_UNENFORCED is not permitted in production')
  if (problems.length || !ledger.enabled) return { enabled: false, reason: 'invalid_config', problems }
  return {
    enabled: true,
    config: {
      primary: { endpoint: pEndpoint, bucket: pBucket, region: env.EVIDENCE_S3_REGION?.trim() || 'auto', accessKeyId: pKey, secretAccessKey: pSecret, forcePathStyle: env.EVIDENCE_S3_FORCE_PATH_STYLE?.trim().toLowerCase() === 'true' },
      backup: { endpoint: bEndpoint, bucket: bBucket, region: env.EVIDENCE_BACKUP_REGION?.trim() || 'auto', accessKeyId: bKey, secretAccessKey: bSecret, forcePathStyle: false },
      ledger: ledger.config, sealKey: wf.sealKey, allowUnenforcedLedger,
    },
  }
}
