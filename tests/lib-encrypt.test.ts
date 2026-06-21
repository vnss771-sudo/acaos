// Unit tests for the AES-256-GCM secret encryption helpers used to protect
// stored mailbox credentials.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  encryptSecret,
  decryptSecret,
  isEncrypted,
  activeKeyId,
  blobKeyId,
  needsReencryption,
  rewrapSecret,
} from '../packages/backend-core/src/lib/encrypt.ts'

// Snapshot/restore the key-related env around a test body so cases that flip
// rotation config never leak into one another.
function withKeyEnv(
  env: { key?: string; keys?: string; active?: string },
  fn: () => void,
) {
  const prev = {
    EMAIL_ENCRYPTION_KEY: process.env.EMAIL_ENCRYPTION_KEY,
    EMAIL_ENCRYPTION_KEYS: process.env.EMAIL_ENCRYPTION_KEYS,
    EMAIL_ENCRYPTION_ACTIVE_KEY_ID: process.env.EMAIL_ENCRYPTION_ACTIVE_KEY_ID,
  }
  const set = (k: keyof typeof prev, v: string | undefined) => {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    set('EMAIL_ENCRYPTION_KEY', env.key)
    set('EMAIL_ENCRYPTION_KEYS', env.keys)
    set('EMAIL_ENCRYPTION_ACTIVE_KEY_ID', env.active)
    fn()
  } finally {
    set('EMAIL_ENCRYPTION_KEY', prev.EMAIL_ENCRYPTION_KEY)
    set('EMAIL_ENCRYPTION_KEYS', prev.EMAIL_ENCRYPTION_KEYS)
    set('EMAIL_ENCRYPTION_ACTIVE_KEY_ID', prev.EMAIL_ENCRYPTION_ACTIVE_KEY_ID)
  }
}

const KEY_A = 'a'.repeat(64)
const KEY_B = 'b'.repeat(64)

test('encrypt/decrypt round-trips with the dev fallback key', () => {
  const secret = 'hunter2-smtp-password'
  const blob = encryptSecret(secret)
  assert.notEqual(blob, secret)
  assert.equal(decryptSecret(blob), secret)
})

test('each encryption uses a fresh IV so ciphertexts differ', () => {
  const a = encryptSecret('same-input')
  const b = encryptSecret('same-input')
  assert.notEqual(a, b)
  assert.equal(decryptSecret(a), decryptSecret(b))
})

test('isEncrypted recognizes the iv:tag:ciphertext blob shape', () => {
  assert.equal(isEncrypted(encryptSecret('x')), true)
  assert.equal(isEncrypted('plain text password'), false)
  assert.equal(isEncrypted('not:enough'), false)
})

test('with no active versioned key, new blobs stay legacy (unversioned) format', () => {
  withKeyEnv({ key: KEY_A }, () => {
    assert.equal(activeKeyId(), null)
    const blob = encryptSecret('legacy-write')
    assert.equal(blobKeyId(blob), null)
    assert.match(blob, /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/)
    assert.equal(decryptSecret(blob), 'legacy-write')
  })
})

test('an active versioned key seals new blobs as k<id>:… and reads them back', () => {
  withKeyEnv({ key: KEY_A, keys: `2:${KEY_B}`, active: '2' }, () => {
    assert.equal(activeKeyId(), '2')
    const blob = encryptSecret('versioned-write')
    assert.equal(blobKeyId(blob), '2')
    assert.match(blob, /^k2:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/)
    assert.equal(isEncrypted(blob), true)
    assert.equal(decryptSecret(blob), 'versioned-write')
  })
})

test('rotation is non-destructive: old legacy blobs still decrypt after a new key goes active', () => {
  let legacyBlob = ''
  withKeyEnv({ key: KEY_A }, () => {
    legacyBlob = encryptSecret('pre-rotation-secret')
  })
  // Bring up a new active key while the legacy key remains configured.
  withKeyEnv({ key: KEY_A, keys: `2:${KEY_B}`, active: '2' }, () => {
    assert.equal(decryptSecret(legacyBlob), 'pre-rotation-secret') // old key still readable
    assert.equal(needsReencryption(legacyBlob), true)             // flagged for migration

    const rewrapped = rewrapSecret(legacyBlob)
    assert.equal(blobKeyId(rewrapped), '2')                        // now under the active key
    assert.equal(needsReencryption(rewrapped), false)
    assert.equal(decryptSecret(rewrapped), 'pre-rotation-secret')  // same plaintext
  })
})

test('decrypting a versioned blob whose key id is missing fails loudly', () => {
  let blob = ''
  withKeyEnv({ key: KEY_A, keys: `2:${KEY_B}`, active: '2' }, () => {
    blob = encryptSecret('orphan')
  })
  withKeyEnv({ key: KEY_A }, () => {
    assert.throws(() => decryptSecret(blob), /No encryption key for version "2"/)
  })
})

test('an active key id absent from the keyring is rejected', () => {
  withKeyEnv({ key: KEY_A, keys: `1:${KEY_B}`, active: '9' }, () => {
    assert.throws(() => encryptSecret('x'), /not present in EMAIL_ENCRYPTION_KEYS/)
  })
})

test('decryptSecret rejects a malformed blob', () => {
  assert.throws(() => decryptSecret('only-one-part'), /Invalid encrypted blob/)
})

test('a configured hex key is honored and validated', () => {
  const prev = process.env.EMAIL_ENCRYPTION_KEY
  try {
    process.env.EMAIL_ENCRYPTION_KEY = 'a'.repeat(64) // 32 bytes hex
    const blob = encryptSecret('configured-key-secret')
    assert.equal(decryptSecret(blob), 'configured-key-secret')

    process.env.EMAIL_ENCRYPTION_KEY = 'tooshort'
    assert.throws(() => encryptSecret('x'), /must be 64 hex chars/)
  } finally {
    if (prev === undefined) delete process.env.EMAIL_ENCRYPTION_KEY
    else process.env.EMAIL_ENCRYPTION_KEY = prev
  }
})
