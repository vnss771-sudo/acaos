import type { Router } from 'express'
import { asyncHandler, ApiError, requireUser } from '../../lib/http.js'
import { prisma } from '@acaos/backend-core/lib/prisma.js'
import { assertMinimumWorkspaceRole } from '../../lib/workspaces.js'
import { normalizeEmail, isValidEmail } from '../../lib/textNormalize.js'
import { recordAudit } from '@acaos/backend-core/lib/audit.js'
import { parseBody, parseParams, parseQuery, idField } from '../../lib/validate.js'
import { requireFreshAuth } from '../../middleware/auth.js'
import {
  subprocessorDisclosure, dpaDisclosure, COMPLIANCE_TERMS_VERSION, SUBPROCESSORS_VERSION, DPA_VERSION,
  LAWFUL_BASES, CONSENT_BASES, CONSENT_SOURCES, AU_CONSENT_BASES, AU_ADDRESS_TYPES,
} from '@acaos/backend-core/lib/subprocessors.js'
import { z } from 'zod'
import type { Assert, Extends, ComplianceUpdateRequest, ConsentRecordRequest, AutonomyUpdateRequest, AutonomyStatus } from '@acaos/shared'
import { createHash } from 'node:crypto'
import { lookupAbn, normalizeAbn, isValidAbnChecksum, AbnLookupNotConfiguredError } from '@acaos/backend-core/lib/abnLookup.js'
import { ProviderError } from '@acaos/backend-core/lib/providerClient.js'
import { isAuConsentBasis, validateAuConsentEvidence } from '@acaos/backend-core/lib/auConsent.js'
import { assessAutonomy, AUTONOMY_CONSENT_VERSION } from '@acaos/backend-core/lib/autonomyReadiness.js'

const workspaceParamsSchema = z.object({ id: idField })

// PATCH body — every field optional; the boolean acknowledgements stamp the
// matching *At + version columns server-side (the client never sets timestamps).
const complianceUpdateSchema = z.object({
  lawfulBasis: z.enum(LAWFUL_BASES).nullable().optional(),
  targetsCanada: z.boolean().optional(),
  targetsAustralia: z.boolean().optional(),
  acceptTerms: z.boolean().optional(),
  acknowledgeSubprocessors: z.boolean().optional(),
  acknowledgeLia: z.boolean().optional(),
  acknowledgeDpa: z.boolean().optional(),
})
type _ComplianceUpdateConforms = Assert<Extends<z.infer<typeof complianceUpdateSchema>, ComplianceUpdateRequest>>

const consentSchema = z.object({
  email: z.string().trim().min(1),
  basis: z.enum([...CONSENT_BASES, ...AU_CONSENT_BASES]),
  source: z.enum(CONSENT_SOURCES),
  note: z.string().trim().max(500).optional(),
  // Spam Act 2003 evidence — validated below for the AU bases (lib/auConsent.ts).
  evidenceUrl: z.string().trim().max(2000).optional(),
  evidenceAt: z.string().trim().max(40).optional(),
  evidenceExcerpt: z.string().trim().max(500).optional(),
  addressType: z.enum(AU_ADDRESS_TYPES).optional(),
  optOutStatementAbsent: z.boolean().optional(),
  roleRelevant: z.boolean().optional(),
})
type _ConsentConforms = Assert<Extends<z.infer<typeof consentSchema>, ConsentRecordRequest>>

// Explicit row shape: keeps this file type-safe under the offline Prisma stub (CI build-deterministic),
// where model delegates return untyped rows.
type ConsentListRow = {
  id: string; emailKey: string; basis: string; source: string; note: string | null; recordedAt: Date
  evidenceUrl: string | null; evidenceAt: Date | null; evidenceExcerpt: string | null; evidenceHash: string | null
  addressType: string | null; optOutStatementAbsent: boolean | null; roleRelevant: boolean | null
}

const consentListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  email: z.string().trim().max(320).optional(),
})

const abnVerifySchema = z.object({ abn: z.string().trim().min(1).max(20) })

const autonomyUpdateSchema = z.object({
  optIn: z.boolean(),
  consentVersion: z.string().trim().max(64).optional(),
})
type _AutonomyUpdateConforms = Assert<Extends<z.infer<typeof autonomyUpdateSchema>, AutonomyUpdateRequest>>

async function autonomyStatus(workspaceId: string): Promise<AutonomyStatus> {
  const [assessment, icp] = await Promise.all([
    assessAutonomy(workspaceId),
    prisma.workspaceICP.findUnique({ where: { workspaceId }, select: { approvalMode: true } }),
  ])
  // Ready only matters when the workspace actually asked for autonomy.
  return { ...assessment, approvalModeOff: icp?.approvalMode === false }
}

const POSTURE_SELECT = {
  lawfulBasis: true, liaAcknowledgedAt: true, termsAcceptedAt: true, termsVersion: true,
  subprocessorsAckAt: true, subprocessorsAckVersion: true, targetsCanada: true, targetsAustralia: true,
  dpaAcknowledgedAt: true, dpaAckVersion: true,
  senderAbn: true, senderAbnStatus: true, senderAbnEntityName: true, senderAbnVerifiedAt: true,
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
      // An admin must not be able to remove an already-recorded Australian link
      // and thereby disable Australia-specific outbound restrictions. A legally
      // reviewed correction requires a separate operator-controlled procedure.
      const data: Record<string, unknown> = {}
      if (body.lawfulBasis !== undefined) data.lawfulBasis = body.lawfulBasis
      if (body.targetsCanada !== undefined) data.targetsCanada = body.targetsCanada
      if (body.targetsAustralia !== undefined) data.targetsAustralia = body.targetsAustralia
      if (body.acceptTerms) { data.termsAcceptedAt = new Date(); data.termsVersion = COMPLIANCE_TERMS_VERSION }
      if (body.acknowledgeSubprocessors) { data.subprocessorsAckAt = new Date(); data.subprocessorsAckVersion = SUBPROCESSORS_VERSION }
      if (body.acknowledgeLia) data.liaAcknowledgedAt = new Date()
      if (body.acknowledgeDpa) { data.dpaAcknowledgedAt = new Date(); data.dpaAckVersion = DPA_VERSION }
      if (Object.keys(data).length === 0) throw new ApiError(400, 'No compliance fields to update')

      // Atomic compare-and-update: a concurrent request must not be able to
      // disable AU targeting after another request has enabled it.
      let posture
      if (body.targetsAustralia === false) {
        const changed = await prisma.workspace.updateMany({
          where: { id: workspaceId, targetsAustralia: false }, data,
        })
        if (changed.count !== 1) {
          throw new ApiError(409, 'Australian targeting cannot be disabled in self-service; contact support for a reviewed correction')
        }
        posture = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: POSTURE_SELECT })
      } else {
        posture = await prisma.workspace.update({ where: { id: workspaceId }, data, select: POSTURE_SELECT })
      }
      void recordAudit({
        workspaceId, actorUserId: user.id, type: 'compliance.updated',
        entityType: 'workspace', entityId: workspaceId, metadata: { fields: Object.keys(data) },
      })
      res.json({ posture })
    })
  )

  // Autonomous-outreach readiness (UQ-40): whether unreviewed drafts may send,
  // and why not. Any member may view.
  workspaceRouter.get(
    '/:id/autonomy',
    asyncHandler(async (req, res) => {
      const user = requireUser(req)
      const { id: workspaceId } = parseParams(workspaceParamsSchema, req)
      await assertMinimumWorkspaceRole(user.id, workspaceId, 'member')
      res.json(await autonomyStatus(workspaceId))
    })
  )

  // Opt in to (or out of) automatic outreach. Admin+, step-up, audited. Opting
  // in names the consent version the admin saw; opting out takes effect at once.
  workspaceRouter.patch(
    '/:id/autonomy',
    requireFreshAuth,
    asyncHandler(async (req, res) => {
      const user = requireUser(req)
      const { id: workspaceId } = parseParams(workspaceParamsSchema, req)
      await assertMinimumWorkspaceRole(user.id, workspaceId, 'admin')
      const body = parseBody(autonomyUpdateSchema, req)
      if (body.optIn && body.consentVersion !== AUTONOMY_CONSENT_VERSION) {
        throw new ApiError(409, 'The autonomy terms changed — review the current version before opting in')
      }
      await prisma.workspace.update({
        where: { id: workspaceId },
        data: body.optIn
          ? { autonomyOptInAt: new Date(), autonomyConsentVersion: AUTONOMY_CONSENT_VERSION }
          : { autonomyOptInAt: null, autonomyConsentVersion: null },
      })
      await recordAudit({
        workspaceId, actorUserId: user.id, type: body.optIn ? 'autonomy.opt_in' : 'autonomy.opt_out',
        entityType: 'workspace', entityId: workspaceId, metadata: { consentVersion: body.optIn ? AUTONOMY_CONSENT_VERSION : null },
      })
      res.json(await autonomyStatus(workspaceId))
    })
  )

  // Review consent records for the compliance UI. Admin+. Validity for Australia is computed
  // server-side (lib/auConsent.ts), so the UI only displays the verdict and never decides it.
  workspaceRouter.get(
    '/:id/consent',
    asyncHandler(async (req, res) => {
      const user = requireUser(req)
      const { id: workspaceId } = parseParams(workspaceParamsSchema, req)
      await assertMinimumWorkspaceRole(user.id, workspaceId, 'admin')
      const { limit, email } = parseQuery(consentListQuerySchema, req)

      const where = { workspaceId, ...(email ? { emailKey: normalizeEmail(email) } : {}) }
      const [rows, total] = await Promise.all([
        prisma.consentRecord.findMany({ where, orderBy: { recordedAt: 'desc' }, take: limit }),
        prisma.consentRecord.count({ where }),
      ])
      res.json({
        total,
        records: (rows as ConsentListRow[]).map((r) => {
          const au = isAuConsentBasis(r.basis) ? validateAuConsentEvidence(r) : null
          return {
            id: r.id, email: r.emailKey, basis: r.basis, source: r.source, note: r.note,
            recordedAt: r.recordedAt.toISOString(),
            evidenceUrl: r.evidenceUrl, evidenceAt: r.evidenceAt ? r.evidenceAt.toISOString() : null,
            evidenceExcerpt: r.evidenceExcerpt, addressType: r.addressType,
            optOutStatementAbsent: r.optOutStatementAbsent, roleRelevant: r.roleRelevant,
            // null = not an Australian basis (never counts for the Spam Act gate)
            qualifiesForAustralia: au ? au.ok : false,
            australiaReasons: au && !au.ok ? au.reasons : (au ? [] : ['Not an Australian consent basis: it does not authorise sends to Australian recipients']),
          }
        }),
      })
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

      const isAu = isAuConsentBasis(body.basis)
      const evidenceAt = body.evidenceAt ? new Date(body.evidenceAt) : null
      if (isAu) {
        // Fail closed: an Australian-basis record without valid Schedule 2 evidence is
        // never stored, so it can never be mistaken for consent later.
        const verdict = validateAuConsentEvidence({
          basis: body.basis, evidenceUrl: body.evidenceUrl, evidenceAt, evidenceExcerpt: body.evidenceExcerpt,
          addressType: body.addressType, optOutStatementAbsent: body.optOutStatementAbsent, roleRelevant: body.roleRelevant,
        })
        if (!verdict.ok) throw new ApiError(400, `Insufficient Spam Act consent evidence: ${verdict.reasons.join('; ')}`)
      }
      const evidenceHash = isAu && (body.evidenceExcerpt || body.evidenceUrl)
        ? createHash('sha256').update(`${body.evidenceUrl ?? ''}\n${body.evidenceExcerpt ?? ''}`).digest('hex')
        : null
      const row = await prisma.consentRecord.create({
        data: {
          workspaceId, emailKey: normalizeEmail(body.email), basis: body.basis, source: body.source, note: body.note ?? null,
          ...(isAu ? {
            evidenceUrl: body.evidenceUrl ?? null, evidenceAt, evidenceExcerpt: body.evidenceExcerpt ?? null, evidenceHash,
            addressType: body.addressType ?? null, optOutStatementAbsent: body.optOutStatementAbsent ?? null,
            roleRelevant: body.roleRelevant ?? null,
          } : {}),
        },
        select: { id: true, recordedAt: true },
      })
      void recordAudit({
        workspaceId, actorUserId: user.id, type: 'consent.recorded',
        entityType: 'consentRecord', entityId: row.id, metadata: { basis: body.basis, source: body.source },
      })
      res.status(201).json({ id: row.id, recordedAt: row.recordedAt.toISOString() })
    })
  )

  // Verify the sender's ABN against the Australian Business Register and store the result.
  // Admin+. The ABN is persisted only when the ABR reports it ACTIVE (the footer prints it only
  // then). The ABR GUID never appears in a response, log or audit row.
  workspaceRouter.post(
    '/:id/compliance/abn',
    asyncHandler(async (req, res) => {
      const user = requireUser(req)
      const { id: workspaceId } = parseParams(workspaceParamsSchema, req)
      await assertMinimumWorkspaceRole(user.id, workspaceId, 'admin')
      const body = parseBody(abnVerifySchema, req)

      const abn = normalizeAbn(body.abn)
      if (!abn || !isValidAbnChecksum(abn)) throw new ApiError(400, 'That is not a valid ABN (11 digits with a valid checksum)')

      let result
      try {
        result = await lookupAbn(abn)
      } catch (err) {
        if (err instanceof AbnLookupNotConfiguredError) throw new ApiError(503, 'ABN verification is not configured on this server')
        if (err instanceof ProviderError) throw new ApiError(502, 'The ABN register could not be reached; try again shortly')
        throw err
      }
      if (!result) throw new ApiError(404, 'No such ABN was found in the Australian Business Register')

      const active = result.status === 'active'
      await prisma.workspace.update({
        where: { id: workspaceId },
        data: active
          ? { senderAbn: result.abn, senderAbnStatus: 'active', senderAbnEntityName: result.entityName, senderAbnVerifiedAt: new Date() }
          : { senderAbn: null, senderAbnStatus: null, senderAbnEntityName: null, senderAbnVerifiedAt: null },
      })
      void recordAudit({
        workspaceId, actorUserId: user.id, type: 'compliance.abn.verified',
        entityType: 'workspace', entityId: workspaceId, metadata: { abn: result.abn, status: result.status },
      })
      if (!active) throw new ApiError(422, 'That ABN is cancelled, so it will not be shown in your email footer')
      res.json({ abn: result.abn, status: result.status, entityName: result.entityName, entityType: result.entityType })
    })
  )
}
