import type { Router } from 'express'
import { asyncHandler, requireUser } from '../../lib/http.js'
import { prisma } from '../../lib/prisma.js'
import { encryptSecret } from '../../lib/encrypt.js'
import { assertPublicMailHost } from '../../lib/ssrf.js'
import { recordAudit } from '../../lib/audit.js'
import { assertWorkspacePermission } from '../../lib/permissions.js'
import { z } from 'zod'
import { parseBody, parseParams, idField } from '../../lib/validate.js'
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

// :id route param.
const workspaceParamsSchema = z.object({ id: idField })

// Runtime request schema — the previous str()/num()/bool() defensive parsing
// expressed as Zod, so its output matches the old handler exactly:
//  - host/user/from/pass: trimmed string, blank/non-string → null
//  - port: a positive number, anything else → null
//  - secure flags: a boolean, otherwise the prior default (smtp false, imap true)
// Invalid-but-present values are tolerated (mapped to the same fallback) so
// behaviour is unchanged; the SSRF/port/secret-preservation logic stays below.
const strField = z.unknown().optional().transform(v => (typeof v === 'string' && v.trim() ? v.trim() : null))
const numField = z.unknown().optional().transform(v => (typeof v === 'number' && v > 0 ? v : null))
const boolField = (def: boolean) => z.unknown().optional().transform(v => (typeof v === 'boolean' ? v : def))
const emailConfigRuntimeSchema = z.object({
  smtpHost:   strField,
  smtpPort:   numField,
  smtpSecure: boolField(false),
  smtpUser:   strField,
  smtpPass:   strField,
  smtpFrom:   strField,
  imapHost:   strField,
  imapPort:   numField,
  imapSecure: boolField(true),
  imapUser:   strField,
  imapPass:   strField,
})

export function registerEmailConfigRoutes(workspaceRouter: Router) {
  workspaceRouter.get(
    '/:id/email-config',
    asyncHandler(async (req, res) => {
      const user = requireUser(req)
      const workspaceId = req.params.id as string

      await assertWorkspacePermission(user.id, workspaceId, 'email_config:manage')

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
      const user = requireUser(req)
      const { id: workspaceId } = parseParams(workspaceParamsSchema, req)

      await assertWorkspacePermission(user.id, workspaceId, 'email_config:manage')

      const parsed = parseBody(emailConfigRuntimeSchema, { body: req.body ?? {} })
      const rawSmtpPass = parsed.smtpPass
      const rawImapPass = parsed.imapPass

      const data = {
        smtpHost:   parsed.smtpHost,
        smtpPort:   parsed.smtpPort,
        smtpSecure: parsed.smtpSecure,
        smtpUser:   parsed.smtpUser,
        smtpPass:   rawSmtpPass ? encryptSecret(rawSmtpPass) : null,
        smtpFrom:   parsed.smtpFrom,
        imapHost:   parsed.imapHost,
        imapPort:   parsed.imapPort,
        imapSecure: parsed.imapSecure,
        imapUser:   parsed.imapUser,
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

      // Audit the config change. Record only non-secret connection hints — never
      // the SMTP/IMAP passwords (encrypted or raw); just whether they were set.
      void recordAudit({
        workspaceId, actorUserId: user.id, type: 'workspace.email_config.update',
        entityType: 'workspaceEmailConfig', entityId: workspaceId,
        metadata: {
          smtpHost: data.smtpHost, smtpPort: data.smtpPort, smtpSecure: data.smtpSecure, smtpUser: data.smtpUser,
          imapHost: data.imapHost, imapPort: data.imapPort, imapSecure: data.imapSecure, imapUser: data.imapUser,
          smtpPassSet: data.smtpPass !== null, imapPassSet: data.imapPass !== null,
        },
      })

      res.json({ ok: true })
    })
  )
}
