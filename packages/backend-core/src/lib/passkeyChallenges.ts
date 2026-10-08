import { randomBytes } from 'node:crypto'
import { prisma } from './prisma.js'

export type PasskeyChallengePurpose = 'registration' | 'authentication' | 'reauthentication'

export async function createPasskeyChallenge(input: {
  userId: string
  purpose: PasskeyChallengePurpose
  ttlMs: number
}) {
  const challenge = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + input.ttlMs)
  await prisma.passkeyChallenge.create({
    data: { userId: input.userId, purpose: input.purpose, challenge, expiresAt },
  })
  return { challenge, expiresAt }
}

export async function consumePasskeyChallenge(input: {
  userId: string
  purpose: PasskeyChallengePurpose
  challenge: string
}) {
  const now = new Date()
  const result = await prisma.passkeyChallenge.updateMany({
    where: {
      userId: input.userId,
      purpose: input.purpose,
      challenge: input.challenge,
      usedAt: null,
      expiresAt: { gt: now },
    },
    data: { usedAt: now },
  })
  return result.count === 1
}

export async function purgeExpiredPasskeyChallenges(now = new Date()) {
  return prisma.passkeyChallenge.deleteMany({ where: { expiresAt: { lt: now } } })
}
