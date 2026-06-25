import type { Router } from 'express'
import { asyncHandler, ApiError } from '../../lib/http.js'
import { prisma } from '../../lib/prisma.js'
import { assertMinimumWorkspaceRole } from '../../lib/workspaces.js'
import { normalizeEmail, isValidEmail } from '../../lib/validation.js'
import { recordAudit } from '../../lib/audit.js'
import { parseBody, parseParams, idField } from '../../lib/validate.js'
import { requireFreshAuth } from '../../middleware/auth.js'
import {
  subprocessorDisclosure, COMPLIANCE_TERMS_VERSION, SUBPROCESSORS_VERSION,
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
} as const

export function registerComplianceRoutes(workspaceRouter: Router) {
  // Current compliance posture + the disclosed sub-processor list (read-only,
  // any member may view).
  workspaceRouter.get(
    '/:id/compliance',
    asyncHandler(async (req, res) => {
      const user = req.user!
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
      })
    })
  )

  // Attest / update compliance posture. Admin+ and step-up (a legal attestation is
  // a sensitive action, like billing / MFA changes).
  workspaceRouter.patch(
    '/:id/compliance',
    requireFreshAuth,
    asyncHandler(async (req, res) => {
      const user = req.user!
      const { id: workspaceId } = parseParams(workspaceParamsSchema, req)
      await assertMinimumWorkspaceRole(user.id, workspaceId, 'admin')

      const body = parseBody(complianceUpdateSchema, req)
      const data: Record<string, unknown> = {}
      if (body.lawfulBasis !== undefined) data.lawfulBasis = body.lawfulBasis
      if (body.targetsCanada !== undefined) data.targetsCanada = body.targetsCanada
      if (body.acceptTerms) { data.termsAcceptedAt = new Date(); data.termsVersion = COMPLIANCE_TERMS_VERSION }
      if (body.acknowledgeSubprocessors) { data.subprocessorsAckAt = new Date(); data.subprocessorsAckVersion = SUBPROCESSORS_VERSION }
      if (body.acknowledgeLia) data.liaAcknowledgedAt = new Date()
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
      const user = req.user!
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
}
