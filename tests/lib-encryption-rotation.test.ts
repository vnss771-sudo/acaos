// Unit tests for rewrapAllSecrets(), the automated form of docs/KEY_ROTATION.md's
// "re-encrypt existing data" step.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { rewrapAllSecrets } from '../packages/backend-core/src/lib/encryptionRotation.ts'
import { encryptSecret, blobKeyId } from '../packages/backend-core/src/lib/encrypt.ts'
import { createFakePrisma, installPrisma, resetPrisma } from './helpers/integration.ts'

const KEY_A = 'a'.repeat(64)
const KEY_B = 'b'.repeat(64)

const prevEnv = {
  EMAIL_ENCRYPTION_KEY: process.env.EMAIL_ENCRYPTION_KEY,
  EMAIL_ENCRYPTION_KEYS: process.env.EMAIL_ENCRYPTION_KEYS,
  EMAIL_ENCRYPTION_ACTIVE_KEY_ID: process.env.EMAIL_ENCRYPTION_ACTIVE_KEY_ID,
}

beforeEach(() => {
  // A legacy (unversioned) key stays configured while key "2" becomes active,
  // matching a mid-rotation deployment per docs/KEY_ROTATION.md.
  process.env.EMAIL_ENCRYPTION_KEY = KEY_A
  process.env.EMAIL_ENCRYPTION_KEYS = `2:${KEY_B}`
  process.env.EMAIL_ENCRYPTION_ACTIVE_KEY_ID = '2'
})

afterEach(() => {
  resetPrisma()
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

function legacyBlob(plaintext: string): string {
  const prevActive = process.env.EMAIL_ENCRYPTION_ACTIVE_KEY_ID
  delete process.env.EMAIL_ENCRYPTION_ACTIVE_KEY_ID
  const blob = encryptSecret(plaintext)
  if (prevActive === undefined) delete process.env.EMAIL_ENCRYPTION_ACTIVE_KEY_ID
  else process.env.EMAIL_ENCRYPTION_ACTIVE_KEY_ID = prevActive
  return blob
}

test('dry run reports pending rewraps without writing', async () => {
  const legacy = legacyBlob('totp-secret-1')
  installPrisma(createFakePrisma({
    user: {
      findMany: async () => [{ id: 'u1', totpSecret: legacy }],
      update: async () => { throw new Error('must not write during dry run') },
    },
    workspaceEmailConfig: {
      findMany: async () => [],
      update: async () => { throw new Error('must not write during dry run') },
    },
  }))

  const summary = await rewrapAllSecrets({ apply: false })
  assert.equal(summary.usersChecked, 1)
  assert.equal(summary.usersRewrapped, 1)
  assert.equal(summary.workspaceEmailConfigsChecked, 0)
  assert.equal(summary.workspaceEmailConfigsRewrapped, 0)
  assert.deepEqual(summary.errors, [])
})

test('rows already sealed under the active key are skipped', async () => {
  const current = encryptSecret('already-current')
  installPrisma(createFakePrisma({
    user: {
      findMany: async () => [{ id: 'u1', totpSecret: current }],
      update: async () => { throw new Error('must not write') },
    },
    workspaceEmailConfig: { findMany: async () => [], update: async () => { throw new Error('must not write') } },
  }))

  const summary = await rewrapAllSecrets({ apply: false })
  assert.equal(summary.usersChecked, 1)
  assert.equal(summary.usersRewrapped, 0)
})

test('apply: true rewraps User.totpSecret and persists the new blob', async () => {
  const legacy = legacyBlob('totp-secret-2')
  const updates: Array<{ id: string; totpSecret: string }> = []
  installPrisma(createFakePrisma({
    user: {
      findMany: async () => [{ id: 'u1', totpSecret: legacy }],
      update: async (args: { where: { id: string }; data: { totpSecret: string } }) => {
        updates.push({ id: args.where.id, totpSecret: args.data.totpSecret })
        return {}
      },
    },
    workspaceEmailConfig: { findMany: async () => [], update: async () => ({}) },
  }))

  const summary = await rewrapAllSecrets({ apply: true })
  assert.equal(summary.usersRewrapped, 1)
  assert.equal(updates.length, 1)
  assert.equal(updates[0].id, 'u1')
  assert.equal(blobKeyId(updates[0].totpSecret), '2')
})

test('apply: true rewraps WorkspaceEmailConfig.smtpPass and imapPass independently', async () => {
  const smtp = legacyBlob('smtp-pass')
  const current = encryptSecret('already-current-imap')
  const updates: Array<{ id: string; data: Record<string, string> }> = []
  installPrisma(createFakePrisma({
    user: { findMany: async () => [], update: async () => ({}) },
    workspaceEmailConfig: {
      findMany: async () => [{ id: 'c1', smtpPass: smtp, imapPass: current }],
      update: async (args: { where: { id: string }; data: Record<string, string> }) => {
        updates.push({ id: args.where.id, data: args.data })
        return {}
      },
    },
  }))

  const summary = await rewrapAllSecrets({ apply: true })
  assert.equal(summary.workspaceEmailConfigsChecked, 1)
  assert.equal(summary.workspaceEmailConfigsRewrapped, 1)
  assert.equal(updates.length, 1)
  // Only smtpPass needed rewrapping — imapPass was already current and must be untouched.
  assert.deepEqual(Object.keys(updates[0].data), ['smtpPass'])
  assert.equal(blobKeyId(updates[0].data.smtpPass), '2')
})

test('idempotent: a second dry run after applying reports nothing pending', async () => {
  const legacy = legacyBlob('totp-secret-3')
  let stored = legacy
  installPrisma(createFakePrisma({
    user: {
      findMany: async () => [{ id: 'u1', totpSecret: stored }],
      update: async (args: { data: { totpSecret: string } }) => {
        stored = args.data.totpSecret
        return {}
      },
    },
    workspaceEmailConfig: { findMany: async () => [], update: async () => ({}) },
  }))

  const first = await rewrapAllSecrets({ apply: true })
  assert.equal(first.usersRewrapped, 1)

  const second = await rewrapAllSecrets({ apply: false })
  assert.equal(second.usersRewrapped, 0)
})

test('a decrypt/rewrap failure on one row is collected as an error and does not abort the run', async () => {
  installPrisma(createFakePrisma({
    user: {
      findMany: async () => [{ id: 'u-bad', totpSecret: 'not-a-valid-blob' }],
      update: async () => ({}),
    },
    workspaceEmailConfig: { findMany: async () => [], update: async () => ({}) },
  }))

  const summary = await rewrapAllSecrets({ apply: false })
  assert.equal(summary.usersChecked, 1)
  assert.equal(summary.usersRewrapped, 0)
  assert.equal(summary.errors.length, 1)
  assert.equal(summary.errors[0].model, 'User')
  assert.equal(summary.errors[0].id, 'u-bad')
})

test('apply: true, a failed User.update is reported ONLY as an error, never also counted rewrapped', async () => {
  const legacy = legacyBlob('totp-secret-fails-write')
  installPrisma(createFakePrisma({
    user: {
      findMany: async () => [{ id: 'u1', totpSecret: legacy }],
      update: async () => { throw new Error('connection reset') },
    },
    workspaceEmailConfig: { findMany: async () => [], update: async () => ({}) },
  }))

  const summary = await rewrapAllSecrets({ apply: true })
  assert.equal(summary.usersRewrapped, 0, 'a row whose write failed must not also be counted as rewrapped')
  assert.equal(summary.errors.length, 1)
  assert.equal(summary.errors[0].id, 'u1')
})

test('a bad imapPass does not discard an already-computed, valid smtpPass rewrap on the same row', async () => {
  const smtp = legacyBlob('smtp-pass-still-good')
  const updates: Array<{ id: string; data: Record<string, string> }> = []
  installPrisma(createFakePrisma({
    user: { findMany: async () => [], update: async () => ({}) },
    workspaceEmailConfig: {
      findMany: async () => [{ id: 'c1', smtpPass: smtp, imapPass: 'not-a-valid-blob' }],
      update: async (args: { where: { id: string }; data: Record<string, string> }) => {
        updates.push({ id: args.where.id, data: args.data })
        return {}
      },
    },
  }))

  const summary = await rewrapAllSecrets({ apply: true })
  // The good column still gets persisted...
  assert.equal(updates.length, 1)
  assert.deepEqual(Object.keys(updates[0].data), ['smtpPass'])
  assert.equal(summary.workspaceEmailConfigsRewrapped, 1)
  // ...and the bad column is still reported as an error, not silently dropped.
  assert.equal(summary.errors.length, 1)
  assert.equal(summary.errors[0].id, 'c1')
  assert.match(summary.errors[0].error, /imapPass/)
})

test('apply: true, a failed WorkspaceEmailConfig.update is reported ONLY as an error, never also counted rewrapped', async () => {
  const smtp = legacyBlob('smtp-pass-fails-write')
  installPrisma(createFakePrisma({
    user: { findMany: async () => [], update: async () => ({}) },
    workspaceEmailConfig: {
      findMany: async () => [{ id: 'c1', smtpPass: smtp, imapPass: null }],
      update: async () => { throw new Error('connection reset') },
    },
  }))

  const summary = await rewrapAllSecrets({ apply: true })
  assert.equal(summary.workspaceEmailConfigsRewrapped, 0, 'a row whose write failed must not also be counted as rewrapped')
  assert.equal(summary.errors.length, 1)
  assert.equal(summary.errors[0].id, 'c1')
})
