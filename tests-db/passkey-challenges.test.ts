// DB-tier tests for the passkey challenge store: challenges are single-use and
// scoped to the ceremony purpose they were issued for.

import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { createPasskeyChallenge, consumePasskeyChallenge } from '../packages/backend-core/src/lib/passkeyChallenges.ts'
import { resetDb, disconnect, seedUserWithWorkspace } from './helpers/db.ts'

after(async () => { await disconnect() })
beforeEach(async () => { await resetDb() })

test('passkey challenge is consumed exactly once', async () => {
  const { user } = await seedUserWithWorkspace()
  const issued = await createPasskeyChallenge({ userId: user.id, purpose: 'registration', ttlMs: 60_000 })
  assert.equal(await consumePasskeyChallenge({ userId: user.id, purpose: 'registration', challenge: issued.challenge }), true)
  assert.equal(await consumePasskeyChallenge({ userId: user.id, purpose: 'registration', challenge: issued.challenge }), false)
})

test('passkey challenge is not consumed under a different ceremony purpose', async () => {
  const { user } = await seedUserWithWorkspace()
  const issued = await createPasskeyChallenge({ userId: user.id, purpose: 'registration', ttlMs: 60_000 })
  assert.equal(await consumePasskeyChallenge({ userId: user.id, purpose: 'authentication', challenge: issued.challenge }), false)
})
