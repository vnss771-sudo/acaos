#!/usr/bin/env node
// Automates the "re-encrypt existing data" step of docs/KEY_ROTATION.md's
// EMAIL_ENCRYPTION_KEY rotation procedure: walks every encrypted column
// (User.totpSecret, WorkspaceEmailConfig.smtpPass/imapPass) and rewraps any
// secret not sealed under the currently active key (EMAIL_ENCRYPTION_ACTIVE_KEY_ID).
//
// Idempotent — safe to re-run; a blob already under the active key is skipped.
// Dry-run by default (reports what WOULD change); pass --yes to actually apply.
//
// Requires a real (non-offline) Prisma client and a reachable DATABASE_URL, and
// the full EMAIL_ENCRYPTION_KEY / EMAIL_ENCRYPTION_KEYS / EMAIL_ENCRYPTION_ACTIVE_KEY_ID
// configuration already in place — this only rewraps existing data, per step 2 of
// docs/KEY_ROTATION.md; steps 1 (add the new key, set it active, deploy) and 3
// (retire the old key once nothing needs it) stay manual/operator-driven.
//
// Usage: node scripts/rotate-encryption-key.mjs [--yes]
import { rewrapAllSecrets } from '../packages/backend-core/src/lib/encryptionRotation.js'

const apply = process.argv.includes('--yes')

try {
  const summary = await rewrapAllSecrets({ apply })
  console.log(`[rotate-encryption-key] ${apply ? 'Applied' : 'DRY RUN'}`)
  console.log(`  User.totpSecret: ${summary.usersChecked} checked, ${summary.usersRewrapped} ${apply ? 'rewrapped' : 'would rewrap'}`)
  console.log(`  WorkspaceEmailConfig: ${summary.workspaceEmailConfigsChecked} checked, ${summary.workspaceEmailConfigsRewrapped} ${apply ? 'rewrapped' : 'would rewrap'}`)
  if (summary.errors.length > 0) {
    console.error(`  ${summary.errors.length} error(s):`)
    for (const e of summary.errors) console.error(`    ${e.model} ${e.id}: ${e.error}`)
  }
  const pending = summary.usersRewrapped + summary.workspaceEmailConfigsRewrapped
  if (!apply && pending > 0) {
    console.log(`Dry run only — ${pending} row(s) would change. Pass --yes to actually apply this.`)
  }
  process.exitCode = summary.errors.length > 0 ? 1 : 0
} catch (err) {
  console.error('[rotate-encryption-key] failed:', err instanceof Error ? err.message : err)
  process.exitCode = 1
}
