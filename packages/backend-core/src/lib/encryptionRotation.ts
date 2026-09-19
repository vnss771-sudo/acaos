// The automated form of the manual migration step docs/KEY_ROTATION.md
// documents for EMAIL_ENCRYPTION_KEY rotation: walk every encrypted column and
// rewrap any secret not sealed under the currently active key
// (EMAIL_ENCRYPTION_ACTIVE_KEY_ID). Idempotent and safe to re-run — a blob
// already sealed under the active key is left untouched, and a re-run after a
// partial failure just picks up wherever it left off.
import { prisma } from './prisma.js'
import { needsReencryption, rewrapSecret } from './encrypt.js'

export type RewrapSummary = {
  usersChecked: number
  usersRewrapped: number
  workspaceEmailConfigsChecked: number
  workspaceEmailConfigsRewrapped: number
  errors: Array<{ model: string; id: string; error: string }>
}

// `apply: false` (the default) reports what WOULD change without writing;
// `apply: true` actually rewraps and persists. The plaintext never leaves
// rewrapSecret()'s own call stack — this function only ever handles blobs.
export async function rewrapAllSecrets(opts: { apply: boolean }): Promise<RewrapSummary> {
  const summary: RewrapSummary = {
    usersChecked: 0, usersRewrapped: 0,
    workspaceEmailConfigsChecked: 0, workspaceEmailConfigsRewrapped: 0,
    errors: [],
  }

  const users = await prisma.user.findMany({
    where: { totpSecret: { not: null } },
    select: { id: true, totpSecret: true },
  })
  for (const user of users as Array<{ id: string; totpSecret: string | null }>) {
    summary.usersChecked += 1
    if (!user.totpSecret) continue
    try {
      if (!needsReencryption(user.totpSecret)) continue
      // Counted only after a real write succeeds (or immediately in dry-run,
      // where nothing is written) — counting before the write let a failed
      // update land in both usersRewrapped and errors for the same row.
      if (opts.apply) {
        await prisma.user.update({ where: { id: user.id }, data: { totpSecret: rewrapSecret(user.totpSecret) } })
      }
      summary.usersRewrapped += 1
    } catch (err) {
      summary.errors.push({ model: 'User', id: user.id, error: err instanceof Error ? err.message : String(err) })
    }
  }

  const configs = await prisma.workspaceEmailConfig.findMany({
    where: { OR: [{ smtpPass: { not: null } }, { imapPass: { not: null } }] },
    select: { id: true, smtpPass: true, imapPass: true },
  })
  for (const config of configs as Array<{ id: string; smtpPass: string | null; imapPass: string | null }>) {
    summary.workspaceEmailConfigsChecked += 1
    // smtpPass and imapPass are independent columns: a corrupt/unparseable blob
    // in one must not discard an already-computed valid rewrap of the other, so
    // each is checked in its own try/catch rather than one for the whole row.
    const data: { smtpPass?: string; imapPass?: string } = {}
    if (config.smtpPass) {
      try {
        if (needsReencryption(config.smtpPass)) data.smtpPass = rewrapSecret(config.smtpPass)
      } catch (err) {
        summary.errors.push({ model: 'WorkspaceEmailConfig', id: config.id, error: `smtpPass: ${err instanceof Error ? err.message : String(err)}` })
      }
    }
    if (config.imapPass) {
      try {
        if (needsReencryption(config.imapPass)) data.imapPass = rewrapSecret(config.imapPass)
      } catch (err) {
        summary.errors.push({ model: 'WorkspaceEmailConfig', id: config.id, error: `imapPass: ${err instanceof Error ? err.message : String(err)}` })
      }
    }
    if (Object.keys(data).length === 0) continue
    try {
      // Counted only after a real write succeeds (or immediately in dry-run) —
      // see the identical comment in the User loop above.
      if (opts.apply) {
        await prisma.workspaceEmailConfig.update({ where: { id: config.id }, data })
      }
      summary.workspaceEmailConfigsRewrapped += 1
    } catch (err) {
      summary.errors.push({ model: 'WorkspaceEmailConfig', id: config.id, error: err instanceof Error ? err.message : String(err) })
    }
  }

  return summary
}
