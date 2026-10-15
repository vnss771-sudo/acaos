// Independent-backup configuration (C3). Separate from the primary evidence store
// and equally FAIL CLOSED: backups are off unless EVIDENCE_BACKUP_ENABLED is exactly
// "true" and every setting is valid. The endpoint is read only from the environment
// (never a request), must be https on an allow-listed Cloudflare R2 hostname, and may
// not be the primary store.
//
//   EVIDENCE_BACKUP_ENABLED            "true" to enable. Unset/"false" = off.
//   EVIDENCE_BACKUP_ENDPOINT           https://<account>.r2.cloudflarestorage.com
//   EVIDENCE_BACKUP_BUCKET             bucket name (must differ from the primary bucket)
//   EVIDENCE_BACKUP_ACCESS_KEY_ID      credential, held by the backup worker only
//   EVIDENCE_BACKUP_SECRET_ACCESS_KEY  credential (never logged)
//   EVIDENCE_BACKUP_REGION             default "auto"
// These must NEVER be set on the API service.

export type EvidenceBackupConfig = {
  endpoint: string
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  forcePathStyle: boolean
}

export type EvidenceBackupState =
  | { enabled: true; config: EvidenceBackupConfig }
  | { enabled: false; reason: 'flag_off' | 'invalid_config'; problems: string[] }

type Env = Record<string, string | undefined>

// <32 hex account id>[.eu|.fedramp].r2.cloudflarestorage.com
export const R2_HOST = /^[0-9a-f]{32}(\.(eu|fedramp))?\.r2\.cloudflarestorage\.com$/

function hostOf(url: string): string {
  try { return new URL(url).host.toLowerCase() } catch { return '' }
}

export function resolveEvidenceBackup(env: Env = process.env): EvidenceBackupState {
  const flag = env.EVIDENCE_BACKUP_ENABLED?.trim().toLowerCase()
  if (!flag || flag === 'false') return { enabled: false, reason: 'flag_off', problems: [] }
  if (flag !== 'true') {
    return { enabled: false, reason: 'invalid_config', problems: ['EVIDENCE_BACKUP_ENABLED must be "true" or "false"'] }
  }
  const problems: string[] = []
  // Deletion credentials belong to the dedicated deletion runner only (C4). A service that
  // can also write or serve evidence must never hold them, so their presence disables it.
  if (Object.keys(env).some((k) => k.startsWith('EVIDENCE_DELETE_') && env[k])) {
    problems.push('EVIDENCE_DELETE_* credentials must not be set on this service')
  }
  const need = (k: string) => {
    const v = env[k]?.trim()
    if (!v) problems.push(`${k} is required`)
    return v ?? ''
  }
  const endpoint = need('EVIDENCE_BACKUP_ENDPOINT')
  const bucket = need('EVIDENCE_BACKUP_BUCKET')
  const accessKeyId = need('EVIDENCE_BACKUP_ACCESS_KEY_ID')
  const secretAccessKey = need('EVIDENCE_BACKUP_SECRET_ACCESS_KEY')

  let host = ''
  if (endpoint) {
    try {
      const u = new URL(endpoint)
      host = u.host.toLowerCase()
      const production = env.NODE_ENV === 'production'
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
      if (u.username || u.password) problems.push('EVIDENCE_BACKUP_ENDPOINT must not embed credentials')
      else if (u.protocol === 'https:' && R2_HOST.test(u.hostname.toLowerCase())) { /* allow-listed */ }
      else if (u.protocol === 'http:' && loopback && !production) { /* local disposable store */ }
      else problems.push('EVIDENCE_BACKUP_ENDPOINT must be an https Cloudflare R2 account endpoint')
      if (u.pathname !== '/' && u.pathname !== '') problems.push('EVIDENCE_BACKUP_ENDPOINT must not include a path')
    } catch {
      problems.push('EVIDENCE_BACKUP_ENDPOINT is not a valid URL')
    }
  }
  if (bucket && !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) problems.push('EVIDENCE_BACKUP_BUCKET is not a valid bucket name')

  // Independence: the backup may not be the primary store, nor share its credentials.
  const pEndpoint = env.EVIDENCE_S3_ENDPOINT?.trim()
  const pBucket = env.EVIDENCE_S3_BUCKET?.trim()
  if (pBucket && bucket && pBucket === bucket && (!pEndpoint || !host || hostOf(pEndpoint) === host)) {
    problems.push('EVIDENCE_BACKUP_BUCKET must differ from the primary bucket')
  }
  if (pEndpoint && host && hostOf(pEndpoint) === host) problems.push('EVIDENCE_BACKUP_ENDPOINT must differ from the primary endpoint')
  if (accessKeyId && accessKeyId === env.EVIDENCE_S3_ACCESS_KEY_ID?.trim()) problems.push('backup credentials must differ from primary credentials')

  if (problems.length) return { enabled: false, reason: 'invalid_config', problems }
  return {
    enabled: true,
    config: { endpoint, bucket, accessKeyId, secretAccessKey, region: env.EVIDENCE_BACKUP_REGION?.trim() || 'auto', forcePathStyle: false },
  }
}
