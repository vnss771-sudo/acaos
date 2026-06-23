import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

const ALG = 'aes-256-gcm'
const KEY_LEN = 32
const IV_LEN = 12

let warnedZeroKey = false

function parseHexKey(raw: string, label: string): Buffer {
  const buf = Buffer.from(raw, 'hex')
  if (buf.length !== KEY_LEN) throw new Error(`${label} must be 64 hex chars (32 bytes)`)
  return buf
}

// Legacy / default key from EMAIL_ENCRYPTION_KEY. It decrypts the original
// unversioned `iv:tag:ct` blobs and — when no active versioned key is configured
// — also encrypts new ones (still unversioned), so an unrotated deployment behaves
// exactly as before.
function getLegacyKey(): Buffer {
  const raw = process.env.EMAIL_ENCRYPTION_KEY || ''
  if (!raw) {
    // Fail closed for any deployed environment. Production always required a key;
    // staging (or any other EXPLICIT non-dev NODE_ENV) must too — a mis-set staging
    // box would otherwise silently encrypt real SMTP creds / TOTP secrets under a
    // known all-zero key, decryptable by anyone with DB read access. Only an unset
    // NODE_ENV (local/test default) or an explicit development/test may fall back.
    const env = (process.env.NODE_ENV || '').trim()
    const allowsInsecureFallback = env === '' || env === 'development' || env === 'test'
    if (!allowsInsecureFallback) {
      throw new Error(`EMAIL_ENCRYPTION_KEY is required when NODE_ENV="${env}" (only an unset NODE_ENV or development/test may use the insecure zeroed dev key)`)
    }
    // Dev-only fallback: zeroed key so the app boots without configuration.
    // Credentials stored this way are NOT safe — always set EMAIL_ENCRYPTION_KEY.
    // Warn once (outside tests) so a shared env running without the key is never
    // silent. Deployed environments already threw above.
    if (!warnedZeroKey && env !== 'test') {
      warnedZeroKey = true
      console.warn('[encrypt] EMAIL_ENCRYPTION_KEY is not set — using an INSECURE zeroed dev key. Stored mail credentials are NOT safe; set EMAIL_ENCRYPTION_KEY before any shared, staging, or production use.')
    }
    return Buffer.alloc(KEY_LEN)
  }
  return parseHexKey(raw, 'EMAIL_ENCRYPTION_KEY')
}

const KEY_ID_RE = /^[A-Za-z0-9]+$/

// Optional versioned keyring from EMAIL_ENCRYPTION_KEYS, a comma-separated list of
// `<id>:<64 hex>` entries, e.g. "2:aaaa…,1:bbbb…". Holding several keys at once is
// what makes rotation non-destructive: the old and new keys both stay readable
// while data is migrated to the new one.
function parseKeyring(): Map<string, Buffer> {
  const ring = new Map<string, Buffer>()
  const raw = (process.env.EMAIL_ENCRYPTION_KEYS || '').trim()
  if (!raw) return ring
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    const idx = trimmed.indexOf(':')
    if (idx <= 0) throw new Error('EMAIL_ENCRYPTION_KEYS entries must be "<id>:<64 hex>"')
    const id = trimmed.slice(0, idx).trim()
    const hex = trimmed.slice(idx + 1).trim()
    if (!KEY_ID_RE.test(id)) throw new Error(`EMAIL_ENCRYPTION_KEYS key id "${id}" must be alphanumeric`)
    if (ring.has(id)) throw new Error(`EMAIL_ENCRYPTION_KEYS has a duplicate key id "${id}"`)
    ring.set(id, parseHexKey(hex, `EMAIL_ENCRYPTION_KEYS[${id}]`))
  }
  return ring
}

// The key id used for NEW writes, or null to fall back to the legacy unversioned
// key. Set EMAIL_ENCRYPTION_ACTIVE_KEY_ID (and add that id to EMAIL_ENCRYPTION_KEYS)
// to start sealing new secrets under a versioned key.
export function activeKeyId(): string | null {
  const id = (process.env.EMAIL_ENCRYPTION_ACTIVE_KEY_ID || '').trim()
  return id ? id : null
}

function getActiveKey(): { id: string | null; key: Buffer } {
  const id = activeKeyId()
  if (!id) return { id: null, key: getLegacyKey() }
  const key = parseKeyring().get(id)
  if (!key) throw new Error(`EMAIL_ENCRYPTION_ACTIVE_KEY_ID "${id}" is not present in EMAIL_ENCRYPTION_KEYS`)
  return { id, key }
}

function resolveDecryptKey(versionId: string | null): Buffer {
  if (!versionId) return getLegacyKey()
  const key = parseKeyring().get(versionId)
  if (!key) throw new Error(`No encryption key for version "${versionId}" — add it to EMAIL_ENCRYPTION_KEYS`)
  return key
}

type ParsedBlob = { versionId: string | null; ivHex: string; tagHex: string; ctHex: string }

function splitBlob(blob: string): ParsedBlob {
  const parts = blob.split(':')
  // Versioned: k<id>:iv:tag:ct
  if (parts.length === 4 && /^k[A-Za-z0-9]+$/.test(parts[0])) {
    return { versionId: parts[0].slice(1), ivHex: parts[1], tagHex: parts[2], ctHex: parts[3] }
  }
  // Legacy: iv:tag:ct
  if (parts.length === 3) {
    return { versionId: null, ivHex: parts[0], tagHex: parts[1], ctHex: parts[2] }
  }
  throw new Error('Invalid encrypted blob')
}

// Encrypts a plaintext string. Returns the legacy `iv:tag:ct` blob when no active
// versioned key is configured, or a versioned `k<id>:iv:tag:ct` blob otherwise.
export function encryptSecret(plaintext: string): string {
  const { id, key } = getActiveKey()
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv(ALG, key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  const body = [iv.toString('hex'), tag.toString('hex'), ct.toString('hex')].join(':')
  return id ? `k${id}:${body}` : body
}

// Decrypts a blob produced by encryptSecret (legacy or versioned).
export function decryptSecret(blob: string): string {
  const { versionId, ivHex, tagHex, ctHex } = splitBlob(blob)
  const key = resolveDecryptKey(versionId)
  const decipher = createDecipheriv(ALG, key, Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
  return Buffer.concat([decipher.update(Buffer.from(ctHex, 'hex')), decipher.final()]).toString('utf8')
}

// Returns true if the string looks like an encrypted blob (legacy or versioned),
// not raw plaintext.
export function isEncrypted(s: string): boolean {
  return /^(k[A-Za-z0-9]+:)?[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]*$/i.test(s)
}

// The key version a blob was sealed under (null = legacy unversioned). Lets a
// rotation job tell which stored rows are still under an old key.
export function blobKeyId(blob: string): string | null {
  return splitBlob(blob).versionId
}

// True when a blob is NOT sealed under the currently-active key, so a rotation
// pass should re-encrypt it (legacy blob while a versioned key is active, or an
// older version than the active one).
export function needsReencryption(blob: string): boolean {
  return blobKeyId(blob) !== activeKeyId()
}

// Decrypt then re-encrypt under the active key. Lets a migration rotate a stored
// secret in place without the plaintext ever leaving this module's caller.
export function rewrapSecret(blob: string): string {
  return encryptSecret(decryptSecret(blob))
}
