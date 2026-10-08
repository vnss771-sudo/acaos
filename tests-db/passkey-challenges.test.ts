import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '@acaos/backend-core/lib/prisma.js'
import { createPasskeyChallenge, consumePasskeyChallenge } from '@acaos/backend-core/lib/passkeyChallenges.js'

let userId = ''

beforeAll(async () => {
  const user = await prisma.user.create({ data: { email: `passkey-${Date.now()}@example.test`, name: 'Passkey Test' } })
  userId = user.id
})

beforeEach(async () => {
  await prisma.passkeyChallenge.deleteMany({ where: { userId } })
})

describe('passkey challenge store', () => {
  it('consumes a challenge exactly once', async () => {
    const issued = await createPasskeyChallenge({ userId, purpose: 'registration', ttlMs: 60_000 })
    await expect(consumePasskeyChallenge({ userId, purpose: 'registration', challenge: issued.challenge })).resolves.toBe(true)
    await expect(consumePasskeyChallenge({ userId, purpose: 'registration', challenge: issued.challenge })).resolves.toBe(false)
  })

  it('does not consume a challenge under a different ceremony purpose', async () => {
    const issued = await createPasskeyChallenge({ userId, purpose: 'registration', ttlMs: 60_000 })
    await expect(consumePasskeyChallenge({ userId, purpose: 'authentication', challenge: issued.challenge })).resolves.toBe(false)
  })
})
