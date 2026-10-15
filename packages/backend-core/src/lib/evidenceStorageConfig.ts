// Evidence-upload configuration. Everything here FAILS CLOSED: uploads are off
// unless the flag is exactly "true" AND every required setting is present and
// valid. Anything else, including a typo in the flag or a half-configured bucket,
// resolves to "disabled" with a reason that never contains a secret.
//
// Environment (all server-side; nothing is read from a request):
//   EVIDENCE_UPLOADS_ENABLED          "true" to enable. Unset/"false" = off.
//   EVIDENCE_S3_ENDPOINT              https URL of the S3-compatible service
//   EVIDENCE_S3_BUCKET                bucket name
//   EVIDENCE_S3_ACCESS_KEY_ID         credential (never logged)
//   EVIDENCE_S3_SECRET_ACCESS_KEY     credential (never logged)
//   EVIDENCE_S3_REGION                default "auto"
//   EVIDENCE_S3_FORCE_PATH_STYLE      "true" for path-style addressing
// Optional limits (invalid values disable uploads rather than being ignored):
//   EVIDENCE_MAX_UPLOAD_BYTES         default 10 MiB, max 25 MiB
//   EVIDENCE_PRESIGN_TTL_SECONDS      default 300, 30..900
//   EVIDENCE_MAX_PIXELS               default 25,000,000
//   EVIDENCE_MAX_FILES_PER_JOB        default 100
//   EVIDENCE_MAX_PENDING_PER_WORKER   default 10
//   EVIDENCE_WORKSPACE_QUOTA_BYTES    default 50 GiB
//   EVIDENCE_ABANDONED_AFTER_SECONDS  default 86400 (1 day), >= 3600

export type EvidenceStorageConfig = {
  endpoint: string
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  forcePathStyle: boolean
  maxUploadBytes: number
  presignTtlSeconds: number
  maxPixels: number
  maxFilesPerJob: number
  maxPendingPerWorker: number
  workspaceQuotaBytes: number
  abandonedAfterSeconds: number
}

export type EvidenceStorageState =
  | { enabled: true; config: EvidenceStorageConfig }
  | { enabled: false; reason: 'flag_off' | 'invalid_config'; problems: string[] }

const MIB = 1024 * 1024

type Env = Record<string, string | undefined>

function int(env: Env, key: string, def: number, min: number, max: number, problems: string[]): number {
  const raw = env[key]?.trim()
  if (!raw) return def
  if (!/^\d+$/.test(raw)) { problems.push(`${key} must be a whole number`); return def }
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n < min || n > max) { problems.push(`${key} must be between ${min} and ${max}`); return def }
  return n
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
}

/** Resolve the evidence-storage state from the environment. Never throws. */
export function resolveEvidenceStorage(env: Env = process.env): EvidenceStorageState {
  const flag = env.EVIDENCE_UPLOADS_ENABLED?.trim().toLowerCase()
  if (!flag || flag === 'false') return { enabled: false, reason: 'flag_off', problems: [] }
  // Any value other than the literal "true" (for example "yes" or "1") is a
  // misconfiguration, and a misconfiguration must not turn uploads on.
  if (flag !== 'true') {
    return { enabled: false, reason: 'invalid_config', problems: ['EVIDENCE_UPLOADS_ENABLED must be "true" or "false"'] }
  }

  const problems: string[] = []
  const need = (key: string): string => {
    const v = env[key]?.trim()
    if (!v) problems.push(`${key} is required`)
    return v ?? ''
  }
  const endpoint = need('EVIDENCE_S3_ENDPOINT')
  const bucket = need('EVIDENCE_S3_BUCKET')
  const accessKeyId = need('EVIDENCE_S3_ACCESS_KEY_ID')
  const secretAccessKey = need('EVIDENCE_S3_SECRET_ACCESS_KEY')

  if (endpoint) {
    try {
      const u = new URL(endpoint)
      const production = env.NODE_ENV === 'production'
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopback(u.hostname) && !production)) {
        problems.push('EVIDENCE_S3_ENDPOINT must be an https URL')
      }
      if (u.username || u.password) problems.push('EVIDENCE_S3_ENDPOINT must not embed credentials')
    } catch {
      problems.push('EVIDENCE_S3_ENDPOINT is not a valid URL')
    }
  }
  // S3 bucket naming (3-63 chars, lowercase letters, digits, dots, hyphens).
  if (bucket && !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) problems.push('EVIDENCE_S3_BUCKET is not a valid bucket name')

  const forcePathRaw = env.EVIDENCE_S3_FORCE_PATH_STYLE?.trim().toLowerCase()
  if (forcePathRaw && forcePathRaw !== 'true' && forcePathRaw !== 'false') problems.push('EVIDENCE_S3_FORCE_PATH_STYLE must be "true" or "false"')

  const config: EvidenceStorageConfig = {
    endpoint, bucket, accessKeyId, secretAccessKey,
    region: env.EVIDENCE_S3_REGION?.trim() || 'auto',
    forcePathStyle: forcePathRaw === 'true',
    maxUploadBytes: int(env, 'EVIDENCE_MAX_UPLOAD_BYTES', 10 * MIB, 1024, 25 * MIB, problems),
    presignTtlSeconds: int(env, 'EVIDENCE_PRESIGN_TTL_SECONDS', 300, 30, 900, problems),
    maxPixels: int(env, 'EVIDENCE_MAX_PIXELS', 25_000_000, 1_000_000, 100_000_000, problems),
    maxFilesPerJob: int(env, 'EVIDENCE_MAX_FILES_PER_JOB', 100, 1, 1000, problems),
    maxPendingPerWorker: int(env, 'EVIDENCE_MAX_PENDING_PER_WORKER', 10, 1, 100, problems),
    workspaceQuotaBytes: int(env, 'EVIDENCE_WORKSPACE_QUOTA_BYTES', 50 * 1024 * MIB, MIB, 10 * 1024 * 1024 * MIB, problems),
    abandonedAfterSeconds: int(env, 'EVIDENCE_ABANDONED_AFTER_SECONDS', 86_400, 3_600, 30 * 86_400, problems),
  }
  if (problems.length) return { enabled: false, reason: 'invalid_config', problems }
  return { enabled: true, config }
}

let warnedKey = ''
/** Log (once per distinct problem set) why uploads are off; the log never contains a secret. */
export function describeEvidenceStorageProblems(state: EvidenceStorageState): string | null {
  if (state.enabled || state.reason !== 'invalid_config') return null
  const msg = `Evidence uploads are DISABLED: ${state.problems.join('; ')}`
  if (msg === warnedKey) return null
  warnedKey = msg
  return msg
}
