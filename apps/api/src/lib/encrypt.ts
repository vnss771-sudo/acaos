import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

const ALG = 'aes-256-gcm'
const KEY_LEN = 32
const IV_LEN = 12
const TAG_LEN = 16

function getKey(): Buffer {
  const raw = process.env.EMAIL_ENCRYPTION_KEY || ''
  if (!raw) {
    // In dev without a key, return a fixed zeroed key so the app still boots.
    // Credentials stored this way are only as safe as the DB — operators MUST
    // set EMAIL_ENCRYPTION_KEY in production.
    return Buffer.alloc(KEY_LEN)
  }
  const buf = Buffer.from(raw, 'hex')
  if (buf.length !== KEY_LEN) throw new Error('EMAIL_ENCRYPTION_KEY must be 64 hex chars (32 bytes)')
  return buf
}

// Encrypts a plaintext string and returns a hex-encoded `iv:tag:ciphertext` blob.
export function encryptSecret(plaintext: string): string {
  const key = getKey()
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv(ALG, key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [iv.toString('hex'), tag.toString('hex'), ct.toString('hex')].join(':')
}

// Decrypts a blob produced by encryptSecret.
export function decryptSecret(blob: string): string {
  const parts = blob.split(':')
  if (parts.length !== 3) throw new Error('Invalid encrypted blob')
  const [ivHex, tagHex, ctHex] = parts
  const key = getKey()
  const decipher = createDecipheriv(ALG, key, Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
  return Buffer.concat([decipher.update(Buffer.from(ctHex, 'hex')), decipher.final()]).toString('utf8')
}

// Returns true if the string looks like an encrypted blob (not raw plaintext).
export function isEncrypted(s: string): boolean {
  return /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]*$/i.test(s)
}
