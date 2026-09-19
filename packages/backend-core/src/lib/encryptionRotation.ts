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
      summary.usersRewrapped += 1
      if (opts.apply) {
        await prisma.user.update({ where: { id: user.id }, data: { totpSecret: rewrapSecret(user.totpSecret) } })
      }
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
    try {
      const data: { smtpPass?: string; imapPass?: string } = {}
      if (config.smtpPass && needsReencryption(config.smtpPass)) data.smtpPass = rewrapSecret(config.smtpPass)
      if (config.imapPass && needsReencryption(config.imapPass)) data.imapPass = rewrapSecret(config.imapPass)
      if (Object.keys(data).length === 0) continue
      summary.workspaceEmailConfigsRewrapped += 1
      if (opts.apply) {
        await prisma.workspaceEmailConfig.update({ where: { id: config.id }, data })
      }
    } catch (err) {
      summary.errors.push({ model: 'WorkspaceEmailConfig', id: config.id, error: err instanceof Error ? err.message : String(err) })
    }
  }

  return summary
}
