import type { Router } from 'express'
import { asyncHandler, ApiError } from '../../lib/http.js'
import { prisma } from '../../lib/prisma.js'
import { ensureWorkspaceSlug, userCanManageWorkspaceBilling, normalizeWorkspaceRole } from '../../lib/workspaces.js'
import { normalizeOptionalString } from '../../lib/validation.js'
import { validate, nonEmptyString } from '../../lib/validate.js'
import { z } from 'zod'
import { createBillingPortalSession } from '../../services/stripe.js'
import { seededScore, SEED_COMPANIES, EXAMPLE_SIGNALS } from './helpers.js'

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
      const user = req.user!
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
    asyncHandler(async (req, res) => {
      const user = req.user!
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
      const user = req.user!
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
      const user = req.user!
      const workspaceId = req.params.id as string
      const existing = await prisma.workspace.findUnique({ where: { id: workspaceId } })
      if (!existing) throw new ApiError(404, 'Workspace not found')

      const membership = await prisma.membership.findFirst({
        where: { userId: user.id, workspaceId: workspaceId, role: { in: ['owner', 'admin'] } },
        select: { role: true }
      })
      if (!membership) throw new ApiError(403, 'Must be owner or admin to update workspace')

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

      res.json({ workspace })
    })
  )

  workspaceRouter.post(
    '/:id/billing-portal',
    asyncHandler(async (req, res) => {
      const user = req.user!
      const allowed = await userCanManageWorkspaceBilling(user.id, req.params.id as string)
      if (!allowed) throw new ApiError(403, 'Access denied')

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
      const user = req.user!
      const workspaceId = req.params.id as string

      const membership = await prisma.membership.findFirst({
        where: { userId: user.id, workspaceId, role: { in: ['owner', 'admin'] } }
      })
      if (!membership) throw new ApiError(403, 'Must be owner or admin')

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
