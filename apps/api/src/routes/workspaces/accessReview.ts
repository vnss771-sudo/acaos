import type { Router } from 'express'
import { asyncHandler, requireUser } from '../../lib/http.js'
import { prisma } from '@acaos/backend-core/lib/prisma.js'
import { assertWorkspacePermission } from '../../lib/permissions.js'
import { escCsv } from '../../lib/csv.js'

// SOC2 access review: for a workspace, list every member with the fields an
// access review needs to decide who should still have access — email, role,
// when they joined, when they last actually signed in, and whether MFA is on.
// Gated the same as member management (admin+, `members:manage`) since the
// report itself is sensitive: it shows which admins/owners do NOT have MFA
// enabled, which is exactly the kind of thing an attacker would want to know.
//
// Fields NOT included because they have no real backing in this codebase (an
// access review should never fabricate a column): there is no SSO/IdP
// integration, no per-session device/IP history beyond RefreshToken rows, and
// no account-disabled flag distinct from workspace membership itself.
export type AccessReviewRow = {
  userId: string
  email: string
  name: string | null
  role: string
  joinedAt: Date
  lastLoginAt: Date | null
  mfaEnabled: boolean
}

async function loadAccessReview(workspaceId: string): Promise<AccessReviewRow[]> {
  const memberships = await prisma.membership.findMany({
    where: { workspaceId },
    include: { user: { select: { id: true, email: true, name: true, lastLoginAt: true, totpEnabled: true } } },
    orderBy: { createdAt: 'asc' },
  })
  return memberships.map((m: any) => ({
    userId: m.user.id,
    email: m.user.email,
    name: m.user.name,
    role: m.role,
    joinedAt: m.createdAt,
    lastLoginAt: m.user.lastLoginAt,
    mfaEnabled: m.user.totpEnabled,
  }))
}

const CSV_HEADERS = ['userId', 'email', 'name', 'role', 'joinedAt', 'lastLoginAt', 'mfaEnabled']

function rowToCsvLine(r: AccessReviewRow): string {
  return [
    escCsv(r.userId),
    escCsv(r.email),
    escCsv(r.name ?? ''),
    escCsv(r.role),
    escCsv(r.joinedAt.toISOString()),
    escCsv(r.lastLoginAt ? r.lastLoginAt.toISOString() : ''),
    escCsv(r.mfaEnabled),
  ].join(',')
}

export function registerAccessReviewRoutes(workspaceRouter: Router) {
  // GET /:id/access-review — JSON, for an in-app review screen.
  workspaceRouter.get(
    '/:id/access-review',
    asyncHandler(async (req, res) => {
      const user = requireUser(req)
      const workspaceId = req.params.id as string
      await assertWorkspacePermission(user.id, workspaceId, 'members:manage')

      const members = await loadAccessReview(workspaceId)
      res.json({ members, generatedAt: new Date().toISOString() })
    })
  )

  // GET /:id/access-review/export — CSV, for periodic offline review (the SOC2
  // evidence artifact: an operator downloads this on a schedule and files it).
  workspaceRouter.get(
    '/:id/access-review/export',
    asyncHandler(async (req, res) => {
      const user = requireUser(req)
      const workspaceId = req.params.id as string
      await assertWorkspacePermission(user.id, workspaceId, 'members:manage')

      const members = await loadAccessReview(workspaceId)

      res.setHeader('Content-Type', 'text/csv')
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="access-review-${workspaceId}-${new Date().toISOString().slice(0, 10)}.csv"`
      )
      res.write(CSV_HEADERS.join(',') + '\n')
      for (const r of members) res.write(rowToCsvLine(r) + '\n')
      res.end()
    })
  )
}
