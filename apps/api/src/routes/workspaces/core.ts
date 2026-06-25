import type { Router } from 'express'
import { asyncHandler, ApiError, requireUser } from '../../lib/http.js'
import { prisma } from '../../lib/prisma.js'
import { ensureWorkspaceSlug, normalizeWorkspaceRole, assertMinimumWorkspaceRole, invalidateWorkspaceMembership } from '../../lib/workspaces.js'
import { assertWorkspacePermission } from '../../lib/permissions.js'
import { normalizeOptionalString } from '../../lib/validation.js'
import { recordAudit, recordCriticalAudit } from '../../lib/audit.js'
import { validate, nonEmptyString } from '../../lib/validate.js'
import { requireFreshAuth } from '../../middleware/auth.js'
import { z } from 'zod'
import type { Assert, Extends, DeleteWorkspaceRequest } from '@acaos/shared'
import { createBillingPortalSession } from '../../services/stripe.js'
import { seededScore, SEED_COMPANIES, EXAMPLE_SIGNALS } from './helpers.js'

// DELETE /:id body — the caller must echo the exact workspace name (GitHub-style
// typed confirmation), so an irreversible erase can't fire from a stray request.
const deleteWorkspaceSchema = z.object({ confirmName: nonEmptyString })
type _DeleteWorkspaceConforms = Assert<Extends<z.infer<typeof deleteWorkspaceSchema>, DeleteWorkspaceRequest>>

// POST / body. name/slug stay optional strings here; the handler keeps its
// normalizeOptionalString() handling and the `if (!name) 400` required check, so
// behaviour (trim, blank→400, slug derived from name) is unchanged. The schema
// just rejects non-string junk for these fields.
const createWorkspaceSchema = z.object({
  name: z.string().optional(),
  slug: z.string().optional(),
})

const updateWorkspaceSchema = z.object({
  name: nonEmptyString.max(100).optional(),
  slug: z.string().trim().min(1).max(60).regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens').optional(),
  senderBusinessName: z.string().trim().max(200).nullable().optional(),
  senderPostalAddress: z.string().trim().max(500).nullable().optional(),
}).refine(
  data => data.name !== undefined || data.slug !== undefined || data.senderBusinessName !== undefined || data.senderPostalAddress !== undefined,
  { message: 'At least one field required' }
)

export function registerCoreRoutes(workspaceRouter: Router) {
  workspaceRouter.get(
    '/',
    asyncHandler(async (req, res) => {
      const user = requireUser(req)
      const rows = await prisma.workspace.findMany({
        where: { memberships: { some: { userId: user.id } } },
        select: {
          id: true, name: true, slug: true, plan: true,
          subscriptionStatus: true, createdAt: true,
          _count: { select: { leads: true, campaigns: true } },
          memberships: { where: { userId: user.id }, select: { role: true }, take: 1 },
        },
        orderBy: { createdAt: 'asc' }
      })
      const workspaces = rows.map((w: (typeof rows)[number]) => {
        const { memberships, ...rest } = w as typeof w & { memberships?: Array<{ role: string }> }
        return { ...rest, role: normalizeWorkspaceRole(memberships?.[0]?.role) }
      })
      res.json({ workspaces })
    })
  )

  workspaceRouter.post(
    '/',
    validate(createWorkspaceSchema),
    asyncHandler(async (req, res) => {
      const user = requireUser(req)
      const name = normalizeOptionalString(req.body?.name)
      const requestedSlug = normalizeOptionalString(req.body?.slug)

      if (!name) throw new ApiError(400, 'Workspace name is required')

      const slug = await ensureWorkspaceSlug(requestedSlug || name)

      const workspace = await prisma.workspace.create({
        data: {
          name,
          slug,
          memberships: { create: { userId: user.id, role: 'owner' } }
        },
        select: { id: true, name: true, slug: true, plan: true }
      })

      res.status(201).json({ workspace })
    })
  )

  workspaceRouter.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const user = requireUser(req)
      const workspaceId = req.params.id as string
      const workspace = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: {
          id: true, name: true, slug: true, plan: true,
          subscriptionStatus: true, createdAt: true, updatedAt: true,
          _count: { select: { leads: true, campaigns: true } }
        }
      })

      if (!workspace) throw new ApiError(404, 'Workspace not found')

      const membership = await prisma.membership.findFirst({
        where: { userId: user.id, workspaceId: workspaceId },
        select: { role: true }
      })
      if (!membership) throw new ApiError(403, 'Access denied')

      res.json({ workspace: { ...workspace, role: membership.role } })
    })
  )

  workspaceRouter.patch(
    '/:id',
    validate(updateWorkspaceSchema),
    asyncHandler(async (req, res) => {
      const user = requireUser(req)
      const workspaceId = req.params.id as string
      const existing = await prisma.workspace.findUnique({ where: { id: workspaceId } })
      if (!existing) throw new ApiError(404, 'Workspace not found')

      await assertWorkspacePermission(user.id, workspaceId, 'workspace:update')

      const updates: { name?: string; slug?: string; senderBusinessName?: string | null; senderPostalAddress?: string | null } = {}

      if (req.body.name) {
        updates.name = req.body.name
      }
      if (req.body.slug) {
        updates.slug = await ensureWorkspaceSlug(req.body.slug, workspaceId)
      }
      if (req.body.senderBusinessName !== undefined) {
        updates.senderBusinessName = req.body.senderBusinessName || null
      }
      if (req.body.senderPostalAddress !== undefined) {
        updates.senderPostalAddress = req.body.senderPostalAddress || null
      }

      if (Object.keys(updates).length === 0) throw new ApiError(400, 'No valid updates provided')

      const workspace = await prisma.workspace.update({
        where: { id: workspaceId },
        data: updates,
        select: { id: true, name: true, slug: true, plan: true, senderBusinessName: true, senderPostalAddress: true }
      })

      // Audit the settings change — log only which fields changed, never the values
      // (sender business name / postal address are tenant PII).
      void recordAudit({
        workspaceId, actorUserId: user.id, type: 'workspace.updated',
        entityType: 'workspace', entityId: workspaceId, metadata: { fields: Object.keys(updates) },
      })

      res.json({ workspace })
    })
  )

  // Irreversible tenant erasure (GDPR Art. 17). Owner-only + step-up auth +
  // typed-name confirmation. Transactional: two decoupled tables (AuditEvent,
  // ScoringOutcome) are deleted explicitly; the other ~27 workspace-scoped tables
  // cascade from the Workspace row (onDelete: Cascade). Refuses while a live Stripe
  // subscription exists so billing can't be orphaned.
  workspaceRouter.delete(
    '/:id',
    requireFreshAuth,
    validate(deleteWorkspaceSchema),
    asyncHandler(async (req, res) => {
      const user = requireUser(req)
      const workspaceId = req.params.id as string

      const ws = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { id: true, name: true, subscriptionStatus: true, stripeSubscriptionId: true },
      })
      if (!ws) throw new ApiError(404, 'Workspace not found')

      // Only an OWNER may erase a workspace.
      await assertMinimumWorkspaceRole(user.id, workspaceId, 'owner')

      // Typed confirmation: the body must echo the exact workspace name.
      if ((req.body as DeleteWorkspaceRequest).confirmName.trim() !== ws.name) {
        throw new ApiError(400, 'confirmName does not match the workspace name')
      }

      // Refuse while a live subscription exists — deleting now would orphan billing
      // (the customer keeps being charged). They must cancel via the portal first.
      const LIVE = new Set(['active', 'trialing', 'past_due', 'unpaid'])
      if (ws.stripeSubscriptionId && LIVE.has(ws.subscriptionStatus ?? '')) {
        throw new ApiError(409, 'Cancel the active subscription before deleting this workspace')
      }

      // Member ids captured BEFORE deletion so we can invalidate their cached roles.
      const members = await prisma.membership.findMany({ where: { workspaceId }, select: { userId: true } })
      const memberIds = members.map((m: { userId: string }) => m.userId)

      // Just three statements: the workspace delete triggers the DB-side ON DELETE
      // CASCADE for the ~27 FK-linked tables in one operation, so this stays well
      // within the default transaction timeout regardless of tenant size.
      await prisma.$transaction(async (tx) => {
        // Decoupled (no FK cascade) — erase explicitly.
        await tx.auditEvent.deleteMany({ where: { workspaceId } })
        await tx.scoringOutcome.deleteMany({ where: { workspaceId } })
        // Everything else cascades from the Workspace row.
        await tx.workspace.delete({ where: { id: workspaceId } })
      })

      // Now-removed members must re-check membership cleanly on their next request.
      for (const uid of memberIds) invalidateWorkspaceMembership(uid, workspaceId)

      // Global audit (workspaceId: null so the record survives the erasure itself).
      // Critical: an erasure with no audit trail is a SOC2 gap — await + alert on failure.
      await recordCriticalAudit({
        workspaceId: null, actorUserId: user.id, type: 'workspace.deleted',
        entityType: 'workspace', entityId: workspaceId, metadata: { name: ws.name, memberCount: memberIds.length },
      })

      res.json({ deleted: true, workspaceId })
    })
  )

  workspaceRouter.post(
    '/:id/billing-portal',
    asyncHandler(async (req, res) => {
      const user = requireUser(req)
      await assertWorkspacePermission(user.id, req.params.id as string, 'billing:manage')

      const workspace = await prisma.workspace.findUnique({
        where: { id: req.params.id as string },
        select: { stripeCustomerId: true }
      })
      if (!workspace?.stripeCustomerId) {
        throw new ApiError(400, 'No billing account found for this workspace')
      }

      const session = await createBillingPortalSession(workspace.stripeCustomerId)
      res.json({ url: session.url })
    })
  )

  // Onboarding seed — marks workspace setup complete and optionally creates
  // example (isExample=true) prospects so the dashboard is never empty on day 1.
  workspaceRouter.post(
    '/:id/seed',
    asyncHandler(async (req, res) => {
      const user = requireUser(req)
      const workspaceId = req.params.id as string

      await assertWorkspacePermission(user.id, workspaceId, 'workspace:seed')

      const playbookId: string | null = typeof req.body?.playbookId === 'string' ? req.body.playbookId : null
      const includeExamples: boolean = req.body?.includeExamples !== false

      // Mark onboarding complete
      await prisma.workspace.update({ where: { id: workspaceId }, data: { onboardingCompleted: true } })

      if (includeExamples && playbookId) {
        // Only seed if no real prospects exist yet
        const existingCount = await prisma.prospect.count({ where: { workspaceId, isExample: false } })
        if (existingCount === 0) {
          const seeds = SEED_COMPANIES[playbookId] ?? SEED_COMPANIES['industrial']

          // Create each prospect individually so we can attach signals + recommendation
          for (const s of seeds) {
            const exampleSignals = EXAMPLE_SIGNALS[s.companyName] ?? EXAMPLE_SIGNALS['__default__']
            const score = {
              opportunityScore: seededScore(s.companyName, 1, 25, 62),
              intentScore:      seededScore(s.companyName, 2, 20, 55),
              fitScore:         seededScore(s.companyName, 3, 20, 58),
              timingScore:      seededScore(s.companyName, 4, 25, 52),
              confidenceScore:  seededScore(s.companyName, 5, 15, 45),
            }
            // Check idempotency
            const already = await prisma.prospect.findFirst({ where: { workspaceId, companyName: s.companyName } })
            if (already) continue

            const prospect = await prisma.prospect.create({
              data: {
                workspaceId,
                companyName: s.companyName,
                industry:    s.industry,
                location:    s.location,
                employeeCount: s.employeeCount,
                description: s.description,
                contactName: s.contactName,
                contactTitle: s.contactTitle,
                isExample: true,
                buyingStage: 'EVALUATING',
                ...score,
              }
            })

            // Seed example signals so the evidence panel has content
            const now = new Date()
            await prisma.signal.createMany({
              data: exampleSignals.map(({ daysAgo, ...sig }) => ({
                workspaceId,
                prospectId: prospect.id,
                ...sig,
                detectedAt: new Date(now.getTime() - daysAgo * 86_400_000),
              }))
            })

            // Seed a recommendation so the hot accounts panel has an action
            await prisma.recommendation.create({
              data: {
                workspaceId,
                prospectId: prospect.id,
                bestContact:  s.contactName,
                bestTiming:   'Next 2 weeks',
                bestChannel:  'Email',
                messageAngle: 'Lead with recent growth evidence and how you reduce operational strain',
                reasoning:    `${s.companyName} is showing ${exampleSignals.length} buying signal${exampleSignals.length !== 1 ? 's' : ''}. They match your ICP and are currently in evaluation mode.`,
                actionText:   'Send introduction email referencing recent activity',
                urgency:      'HIGH',
                priority:     score.opportunityScore,
                expiresAt:    new Date(Date.now() + 14 * 86_400_000),
              }
            })
          }
        }
      }

      res.json({ ok: true })
    })
  )
}
