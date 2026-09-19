import type { Router } from 'express'
import { asyncHandler, ApiError, requireUser } from '../../lib/http.js'
import { prisma } from '@acaos/backend-core/lib/prisma.js'
import { assertMinimumWorkspaceRole } from '../../lib/workspaces.js'
import { normalizeEmail, isValidEmail } from '../../lib/textNormalize.js'
import { recordAudit } from '@acaos/backend-core/lib/audit.js'
import { parseBody, parseParams, idField } from '../../lib/validate.js'
import { requireFreshAuth } from '../../middleware/auth.js'
import { isEncrypted } from '@acaos/backend-core/lib/encrypt.js'
import {
  subprocessorDisclosure, dpaDisclosure, COMPLIANCE_TERMS_VERSION, SUBPROCESSORS_VERSION, DPA_VERSION,
  LAWFUL_BASES, CONSENT_BASES, CONSENT_SOURCES,
} from '@acaos/backend-core/lib/subprocessors.js'
import { z } from 'zod'
import type { Assert, Extends, ComplianceUpdateRequest, ConsentRecordRequest } from '@acaos/shared'

const workspaceParamsSchema = z.object({ id: idField })

// PATCH body — every field optional; the boolean acknowledgements stamp the
// matching *At + version columns server-side (the client never sets timestamps).
const complianceUpdateSchema = z.object({
  lawfulBasis: z.enum(LAWFUL_BASES).nullable().optional(),
  targetsCanada: z.boolean().optional(),
  acceptTerms: z.boolean().optional(),
  acknowledgeSubprocessors: z.boolean().optional(),
  acknowledgeLia: z.boolean().optional(),
  acknowledgeDpa: z.boolean().optional(),
})
type _ComplianceUpdateConforms = Assert<Extends<z.infer<typeof complianceUpdateSchema>, ComplianceUpdateRequest>>

const consentSchema = z.object({
  email: z.string().trim().min(1),
  basis: z.enum(CONSENT_BASES),
  source: z.enum(CONSENT_SOURCES),
  note: z.string().trim().max(500).optional(),
})
type _ConsentConforms = Assert<Extends<z.infer<typeof consentSchema>, ConsentRecordRequest>>

const POSTURE_SELECT = {
  lawfulBasis: true, liaAcknowledgedAt: true, termsAcceptedAt: true, termsVersion: true,
  subprocessorsAckAt: true, subprocessorsAckVersion: true, targetsCanada: true,
  dpaAcknowledgedAt: true, dpaAckVersion: true,
} as const

export function registerComplianceRoutes(workspaceRouter: Router) {
  // Current compliance posture + the disclosed sub-processor list (read-only,
  // any member may view).
  workspaceRouter.get(
    '/:id/compliance',
    asyncHandler(async (req, res) => {
      const user = requireUser(req)
      const { id: workspaceId } = parseParams(workspaceParamsSchema, req)
      await assertMinimumWorkspaceRole(user.id, workspaceId, 'member')

      const [posture, consentCount] = await Promise.all([
        prisma.workspace.findUnique({ where: { id: workspaceId }, select: POSTURE_SELECT }),
        prisma.consentRecord.count({ where: { workspaceId } }),
      ])
      if (!posture) throw new ApiError(404, 'Workspace not found')

      res.json({
        posture,
        consentCount,
        currentTermsVersion: COMPLIANCE_TERMS_VERSION,
        subprocessors: subprocessorDisclosure(),
        dpa: dpaDisclosure(),
      })
    })
  )

  // Attest / update compliance posture. Admin+ and step-up (a legal attestation is
  // a sensitive action, like billing / MFA changes).
  workspaceRouter.patch(
    '/:id/compliance',
    requireFreshAuth,
    asyncHandler(async (req, res) => {
      const user = requireUser(req)
      const { id: workspaceId } = parseParams(workspaceParamsSchema, req)
      await assertMinimumWorkspaceRole(user.id, workspaceId, 'admin')

      const body = parseBody(complianceUpdateSchema, req)
      const data: Record<string, unknown> = {}
      if (body.lawfulBasis !== undefined) data.lawfulBasis = body.lawfulBasis
      if (body.targetsCanada !== undefined) data.targetsCanada = body.targetsCanada
      if (body.acceptTerms) { data.termsAcceptedAt = new Date(); data.termsVersion = COMPLIANCE_TERMS_VERSION }
      if (body.acknowledgeSubprocessors) { data.subprocessorsAckAt = new Date(); data.subprocessorsAckVersion = SUBPROCESSORS_VERSION }
      if (body.acknowledgeLia) data.liaAcknowledgedAt = new Date()
      if (body.acknowledgeDpa) { data.dpaAcknowledgedAt = new Date(); data.dpaAckVersion = DPA_VERSION }
      if (Object.keys(data).length === 0) throw new ApiError(400, 'No compliance fields to update')

      const posture = await prisma.workspace.update({ where: { id: workspaceId }, data, select: POSTURE_SELECT })
      void recordAudit({
        workspaceId, actorUserId: user.id, type: 'compliance.updated',
        entityType: 'workspace', entityId: workspaceId, metadata: { fields: Object.keys(data) },
      })
      res.json({ posture })
    })
  )

  // Append a consent / lawful-basis record for a recipient. Admin+ (it's an
  // assertion about a third party); step-up not required (high-volume import path).
  workspaceRouter.post(
    '/:id/consent',
    asyncHandler(async (req, res) => {
      const user = requireUser(req)
      const { id: workspaceId } = parseParams(workspaceParamsSchema, req)
      await assertMinimumWorkspaceRole(user.id, workspaceId, 'admin')

      const body = parseBody(consentSchema, req)
      if (!isValidEmail(body.email)) throw new ApiError(400, 'A valid recipient email is required')

      const row = await prisma.consentRecord.create({
        data: { workspaceId, emailKey: normalizeEmail(body.email), basis: body.basis, source: body.source, note: body.note ?? null },
        select: { id: true, recordedAt: true },
      })
      void recordAudit({
        workspaceId, actorUserId: user.id, type: 'consent.recorded',
        entityType: 'consentRecord', entityId: row.id, metadata: { basis: body.basis, source: body.source },
      })
      res.status(201).json({ id: row.id, recordedAt: row.recordedAt.toISOString() })
    })
  )

  // GET /:id/data-export — GDPR data export (Art. 15). Downloads all workspace
  // data as JSON: members, prospects, campaigns, email logs, audit trail, consent
  // records. Encrypted fields (SMTP/IMAP passwords, keys) are EXCLUDED from export
  // to prevent accidental credential leaks. Any member can request export (GDPR
  // does not require admin verification). Triggers audit trail.
  workspaceRouter.get(
    '/:id/data-export',
    asyncHandler(async (req, res) => {
      const user = requireUser(req)
      const { id: workspaceId } = parseParams(workspaceParamsSchema, req)

      // Verify access: any member of workspace may export
      await assertMinimumWorkspaceRole(user.id, workspaceId, 'member')

      const workspace = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { id: true, name: true, slug: true, createdAt: true, updatedAt: true }
      })
      if (!workspace) throw new ApiError(404, 'Workspace not found')

      // Collect all workspace-scoped data in parallel
      const [members, prospects, campaigns, sends, leads, auditEvents, consentRecords, emailConfig] = await Promise.all([
        prisma.membership.findMany({
          where: { workspaceId },
          select: { userId: true, role: true, createdAt: true },
        }),
        prisma.prospect.findMany({
          where: { workspaceId },
          select: {
            id: true, companyName: true, industry: true, location: true, employeeCount: true,
            description: true, contactName: true, contactTitle: true, buyingStage: true,
            createdAt: true,
          },
        }),
        prisma.campaign.findMany({
          where: { workspaceId },
          select: {
            id: true, name: true, description: true, goalType: true,
            createdAt: true, updatedAt: true,
          },
        }),
        prisma.outreachSent.findMany({
          where: { workspaceId },
          select: {
            id: true, toEmail: true, subject: true, status: true, replyIntent: true,
            replySummary: true, sentAt: true, repliedAt: true,
          },
        }),
        prisma.lead.findMany({
          where: { workspaceId },
          select: { id: true, businessName: true, email: true, stage: true, createdAt: true },
        }),
        prisma.auditEvent.findMany({
          where: { workspaceId },
          select: {
            id: true, type: true, entityType: true, entityId: true,
            actorUserId: true, createdAt: true,
          },
        }),
        prisma.consentRecord.findMany({
          where: { workspaceId },
          select: { id: true, emailKey: true, basis: true, source: true, recordedAt: true },
        }),
        prisma.workspaceEmailConfig.findUnique({
          where: { workspaceId },
          select: {
            smtpHost: true, smtpPort: true, smtpSecure: true, smtpUser: true, smtpFrom: true,
            imapHost: true, imapPort: true, imapSecure: true, imapUser: true,
          },
        }),
      ])

      // Build export with plaintext & metadata, no secrets
      const exportData = {
        exportedAt: new Date().toISOString(),
        exportedBy: user.id,
        exportVersion: '1.0',
        workspace,
        members,
        prospects,
        campaigns,
        outreachSends: sends,
        leads,
        consentRecords,
        auditLog: auditEvents,
        emailConfig: emailConfig ? {
          ...emailConfig,
          smtpPasswordEncrypted: !!emailConfig ? 'REDACTED' : false,
          imapPasswordEncrypted: !!emailConfig ? 'REDACTED' : false,
        } : null,
      }

      // Audit the export request
      void recordAudit({
        workspaceId,
        actorUserId: user.id,
        type: 'gdpr.data_export',
        entityType: 'workspace',
        entityId: workspaceId,
        metadata: { recordCount: prospects.length + campaigns.length + sends.length + leads.length },
      })

      // Return as attachment with ISO timestamp
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Content-Disposition', `attachment; filename="workspace-export-${new Date().toISOString().split('T')[0]}.json"`)
      res.json(exportData)
    })
  )

  // POST /:id/encryption-verify — verify that email credentials are encrypted.
  // Used for compliance audits to confirm no plaintext secrets are at rest.
  // Returns: { encrypted: boolean, warning?: string } (true if all passwords
  // are properly encrypted, false if any plaintext found).
  workspaceRouter.post(
    '/:id/encryption-verify',
    asyncHandler(async (req, res) => {
      const user = requireUser(req)
      const { id: workspaceId } = parseParams(workspaceParamsSchema, req)

      // Owner+ may verify encryption posture
      await assertMinimumWorkspaceRole(user.id, workspaceId, 'admin')

      const config = await prisma.workspaceEmailConfig.findUnique({ where: { workspaceId } })

      let encrypted = true
      const warnings: string[] = []

      if (config?.smtpPass) {
        if (!isEncrypted(config.smtpPass)) {
          encrypted = false
          warnings.push('SMTP password appears to be plaintext (should be encrypted)')
        }
      }

      if (config?.imapPass) {
        if (!isEncrypted(config.imapPass)) {
          encrypted = false
          warnings.push('IMAP password appears to be plaintext (should be encrypted)')
        }
      }

      // Audit the encryption check
      void recordAudit({
        workspaceId,
        actorUserId: user.id,
        type: 'compliance.encryption_verify',
        entityType: 'workspace',
        entityId: workspaceId,
        metadata: { encrypted, warningCount: warnings.length },
      })

      res.json({
        encrypted,
        ...(warnings.length > 0 && { warning: warnings.join('; ') }),
      })
    })
  )
}
