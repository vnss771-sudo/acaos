import fs from 'node:fs'

const schema = fs.readFileSync('packages/db/prisma/schema.prisma', 'utf8')
const migration = fs.readFileSync('packages/db/prisma/migrations/20261008120000_passkeys/migration.sql', 'utf8')
const cfg = fs.readFileSync('packages/backend-core/src/lib/webauthnConfig.ts', 'utf8')
const challenges = fs.readFileSync('packages/backend-core/src/lib/passkeyChallenges.ts', 'utf8')

const failures = []
for (const token of ['model PasskeyCredential', 'credentialId String   @unique', 'publicKey    Bytes', 'counter      BigInt', 'model PasskeyChallenge', 'challenge String   @unique', 'expiresAt DateTime', 'usedAt    DateTime?']) {
  if (!schema.includes(token)) failures.push(`schema missing: ${token}`)
}
for (const token of ['CREATE TABLE "PasskeyCredential"', 'CREATE UNIQUE INDEX "PasskeyCredential_credentialId_key"', 'CREATE TABLE "PasskeyChallenge"', 'PasskeyChallenge_challenge_key']) {
  if (!migration.includes(token)) failures.push(`migration missing: ${token}`)
}
for (const token of ['WEBAUTHN_ENABLED', 'WEBAUTHN_RP_ID', 'WEBAUTHN_ORIGIN', 'https:', 'localhost']) {
  if (!cfg.includes(token)) failures.push(`config missing: ${token}`)
}
for (const token of ['randomBytes(32)', 'usedAt: null', 'expiresAt: { gt: now }', 'result.count === 1']) {
  if (!challenges.includes(token)) failures.push(`challenge store missing: ${token}`)
}
if (failures.length) {
  console.error('[passkey-foundation] FAIL')
  for (const f of failures) console.error(` - ${f}`)
  process.exit(1)
}
console.log('[passkey-foundation] PASS')
