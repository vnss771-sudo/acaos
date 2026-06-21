import type { Router } from 'express'
import { asyncHandler, ApiError } from '../../lib/http.js'
import { prisma } from '../../lib/prisma.js'
import { encryptSecret } from '../../lib/encrypt.js'
import { assertPublicMailHost } from '../../lib/ssrf.js'
import { z } from 'zod'
import type { Assert, EmailConfigRequest, Extends } from '@acaos/shared'
import { validateMailPort } from './helpers.js'

// Request contract for PUT /:id/email-config, pinned to the shared type so the
// accepted body shape can't drift from EmailConfigRequest. The handler parses
// req.body defensively (below) rather than through this schema, so this is a
// compile-time guard only — adding runtime validation would change behaviour.
const _emailConfigSchema = z.object({
  smtpHost:   z.string().nullish(),
  smtpPort:   z.number().nullish(),
  smtpSecure: z.boolean().optional(),
  smtpUser:   z.string().nullish(),
  smtpPass:   z.string().nullish(),
  smtpFrom:   z.string().nullish(),
  imapHost:   z.string().nullish(),
  imapPort:   z.number().nullish(),
  imapSecure: z.boolean().optional(),
  imapUser:   z.string().nullish(),
  imapPass:   z.string().nullish(),
})
type _EmailConfigConforms = Assert<Extends<z.infer<typeof _emailConfigSchema>, EmailConfigRequest>>

export function registerEmailConfigRoutes(workspaceRouter: Router) {
  workspaceRouter.get(
    '/:id/email-config',
    asyncHandler(async (req, res) => {
      const user = req.user!
      const workspaceId = req.params.id as string

      const canManage = await prisma.membership.findFirst({
        where: { userId: user.id, workspaceId, role: { in: ['owner', 'admin'] } }
      })
      if (!canManage) throw new ApiError(403, 'Must be owner or admin')

      const config = await prisma.workspaceEmailConfig.findUnique({ where: { workspaceId } })
      // Never return smtpPass / imapPass in plaintext — only indicate presence
      res.json({
        config: config ? {
          smtpHost: config.smtpHost,
          smtpPort: config.smtpPort,
          smtpSecure: config.smtpSecure,
          smtpUser: config.smtpUser,
          smtpFrom: config.smtpFrom,
          smtpPassSet: !!config.smtpPass,
          imapHost: config.imapHost,
          imapPort: config.imapPort,
          imapSecure: config.imapSecure,
          imapUser: config.imapUser,
          imapPassSet: !!config.imapPass,
        } : null
      })
    })
  )

  workspaceRouter.put(
    '/:id/email-config',
    asyncHandler(async (req, res) => {
      const user = req.user!
      const workspaceId = req.params.id as string

      const canManage = await prisma.membership.findFirst({
        where: { userId: user.id, workspaceId, role: { in: ['owner', 'admin'] } }
      })
      if (!canManage) throw new ApiError(403, 'Must be owner or admin')

      const b = req.body ?? {}
      const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
      const num = (v: unknown) => (typeof v === 'number' && v > 0 ? v : null)
      const bool = (v: unknown, def: boolean) => (typeof v === 'boolean' ? v : def)

      const rawSmtpPass = str(b.smtpPass)
      const rawImapPass = str(b.imapPass)

      const data = {
        smtpHost:   str(b.smtpHost),
        smtpPort:   num(b.smtpPort),
        smtpSecure: bool(b.smtpSecure, false),
        smtpUser:   str(b.smtpUser),
        smtpPass:   rawSmtpPass ? encryptSecret(rawSmtpPass) : null,
        smtpFrom:   str(b.smtpFrom),
        imapHost:   str(b.imapHost),
        imapPort:   num(b.imapPort),
        imapSecure: bool(b.imapSecure, true),
        imapUser:   str(b.imapUser),
        imapPass:   rawImapPass ? encryptSecret(rawImapPass) : null,
      }

      // F-04: SSRF validation — reject hosts that are, or resolve to, private/
      // reserved/metadata addresses, plus non-standard ports.
      await assertPublicMailHost(data.smtpHost, 'smtpHost')
      await assertPublicMailHost(data.imapHost, 'imapHost')
      validateMailPort(data.smtpPort, [25, 465, 587, 2525], 'smtpPort')
      validateMailPort(data.imapPort, [143, 993], 'imapPort')

      // If password fields omitted (null), preserve existing encrypted values
      const existing = await prisma.workspaceEmailConfig.findUnique({ where: { workspaceId } })
      if (data.smtpPass === null && existing?.smtpPass) data.smtpPass = existing.smtpPass
      if (data.imapPass === null && existing?.imapPass) data.imapPass = existing.imapPass

      await prisma.workspaceEmailConfig.upsert({
        where: { workspaceId },
        create: { workspaceId, ...data },
        update: data,
      })

      res.json({ ok: true })
    })
  )
}
