// Unit tests for the AES-256-GCM secret encryption helpers used to protect
// stored mailbox credentials.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encryptSecret, decryptSecret, isEncrypted } from '../packages/backend-core/src/lib/encrypt.ts'

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
