import type { Router } from 'express'
import { asyncHandler, ApiError } from '../../lib/http.js'
import { prisma } from '../../lib/prisma.js'
import { invalidateWorkspaceMembership } from '../../lib/workspaces.js'
import { assertWorkspacePermission, roleCan } from '../../lib/permissions.js'
import { generateRefreshToken, hashRefreshToken } from '../../lib/jwt.js'
import { isMailConfigured, sendMail } from '../../services/mail.js'
import { escapeHtml } from '../../lib/html.js'
import { normalizeEmail, isValidEmail } from '../../lib/validation.js'
import { recordAudit } from '../../lib/audit.js'
import { parseBody, parseParams, idField } from '../../lib/validate.js'
import { z } from 'zod'

// :id route param shared by every member/invite endpoint.
const workspaceParamsSchema = z.object({ id: idField })

// Body for POST /:id/members and POST /:id/invites. email stays an optional
// loosely-typed string so the handlers keep their existing required/validity
// checks (members: `if (!email) 400`; invites: isValidEmail → 400) in the same
// order relative to the owner-only admin-grant check. role mirrors the prior
// `['admin','member'].includes(role) ? role : 'member'`: anything else (including
// missing or junk) falls back to 'member'.
const memberBodySchema = z.object({
  email: z.string().optional(),
  role: z.enum(['admin', 'member']).catch('member').default('member'),
})

export function registerMemberRoutes(workspaceRouter: Router) {
  workspaceRouter.get(
    '/:id/members',
    asyncHandler(async (req, res) => {
      const user = req.user!
      const membersWorkspaceId = req.params.id as string
      const membership = await prisma.membership.findFirst({
        where: { userId: user.id, workspaceId: membersWorkspaceId },
        select: { role: true }
      })
      if (!membership) throw new ApiError(403, 'Access denied')

      const members = await prisma.membership.findMany({
        where: { workspaceId: membersWorkspaceId },
        include: { user: { select: { id: true, email: true, name: true } } },
        orderBy: { createdAt: 'asc' }
      })

      res.json({ members })
    })
  )

  workspaceRouter.post(
    '/:id/members',
    asyncHandler(async (req, res) => {
      const user = req.user!
      const { id: workspaceId } = parseParams(workspaceParamsSchema, req)

      const callerRole = await assertWorkspacePermission(user.id, workspaceId, 'members:manage')

      const parsed = parseBody(memberBodySchema, req)
      const email = typeof parsed.email === 'string' ? parsed.email.trim().toLowerCase() : ''
      const role = parsed.role
      // Only an owner may grant the admin role; an admin can add members only. This
      // stops an admin from minting a second admin (lateral privilege escalation).
      if (role === 'admin' && !roleCan(callerRole, 'members:grant_admin')) {
        throw new ApiError(403, 'Only an owner can grant the admin role')
      }

      if (!email) throw new ApiError(400, 'email required')

      const invitee = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true, name: true } })
      if (!invitee) throw new ApiError(404, 'User not found — ask them to create an account first')

      if (invitee.id === user.id) throw new ApiError(400, 'You are already a member')

      const existing = await prisma.membership.findFirst({ where: { userId: invitee.id, workspaceId } })
      if (existing) throw new ApiError(409, 'User is already a member of this workspace')

      await prisma.membership.create({ data: { userId: invitee.id, workspaceId, role } })
      // The invitee may have a cached `null` role for this workspace from a prior
      // denied check — drop it so they're admitted immediately.
      invalidateWorkspaceMembership(invitee.id, workspaceId)

      // Audit the membership add + role assignment (the role-change action for
      // directly-added members).
      void recordAudit({
        workspaceId, actorUserId: user.id, type: 'workspace.member.add',
        entityType: 'membership', entityId: invitee.id,
        metadata: { memberId: invitee.id, email: invitee.email, role },
      })

      res.status(201).json({ member: { email: invitee.email, name: invitee.name, role } })
    })
  )

  // ── Workspace invites ─────────────────────────────────────────────────────────

  workspaceRouter.post(
    '/:id/invites',
    asyncHandler(async (req, res) => {
      const user = req.user!
      const { id: workspaceId } = parseParams(workspaceParamsSchema, req)

      const callerRole = await assertWorkspacePermission(user.id, workspaceId, 'members:manage')

      const parsed = parseBody(memberBodySchema, req)
      const rawEmail = typeof parsed.email === 'string' ? parsed.email : ''
      const email = normalizeEmail(rawEmail)
      if (!isValidEmail(email)) throw new ApiError(400, 'Valid email required')

      const role = parsed.role
      // Only an owner may grant the admin role (see member-add above).
      if (role === 'admin' && !roleCan(callerRole, 'members:grant_admin')) {
        throw new ApiError(403, 'Only an owner can grant the admin role')
      }

      // Check if already a member
      const existingUser = await prisma.user.findUnique({ where: { email } })
      if (existingUser) {
        const isMember = await prisma.membership.findFirst({ where: { userId: existingUser.id, workspaceId } })
        if (isMember) throw new ApiError(409, 'This person is already a member — add them directly using their email')
      }

      const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } })

      const rawToken = generateRefreshToken()
      const tokenHash = hashRefreshToken(rawToken)
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days

      await prisma.workspaceInvite.upsert({
        where: { workspaceId_email: { workspaceId, email } },
        create: { workspaceId, email, role, tokenHash, expiresAt },
        update: { role, tokenHash, expiresAt, acceptedAt: null }, // refresh existing invite
      })

      // Audit the invite creation. Record the target email + role only — never the
      // raw token or its hash.
      void recordAudit({
        workspaceId, actorUserId: user.id, type: 'workspace.invite.create',
        entityType: 'workspaceInvite',
        metadata: { email, role },
      })

      const appUrl = (process.env.APP_URL || 'http://localhost:5173').replace(/\/$/, '')
      // Security (F-xx): carry the invite token in the URL *fragment* (`#invite=`)
      // not the query string. Fragments are never sent in the Referer header or
      // written to server access logs, so the single-use token can't leak via
      // either path — matching the reset/verify token relocation.
      const inviteUrl = `${appUrl}#invite=${rawToken}`

      if (isMailConfigured()) {
        // Escape the workspace name — it is user-controlled and must not be able to
        // inject markup into the HTML email body. The subject is plain text.
        const safeName = escapeHtml(workspace?.name ?? 'a workspace')
        // Escape the URL for the attribute context too. The token is hex and APP_URL
        // is operator-set, so this is defence-in-depth: a misconfigured/injected
        // APP_URL cannot break out of the href and inject markup into the email body.
        const safeInviteUrl = escapeHtml(inviteUrl)
        await sendMail(email, `You've been invited to join ${workspace?.name ?? 'a workspace'} on ACAOS`,
          `<p>You've been invited to join <strong>${safeName}</strong> on ACAOS as ${role === 'admin' ? 'an admin' : 'a member'}.</p>` +
          `<p><a href="${safeInviteUrl}">Accept invitation</a></p>` +
          `<p>This link expires in 7 days. If you don't have an ACAOS account yet, you'll be asked to create one first.</p>`
        )
      } else if (process.env.NODE_ENV === 'production') {
        // Strip CR/LF from the user-supplied email before logging to prevent
        // log-injection / forged log entries.
        const safeEmail = email.replace(/[\r\n]/g, '')
        // Never log a URL containing the raw invite token in production.
        console.warn(`[invites] SMTP not configured; invite email was not sent to ${safeEmail}`)
      } else {
        const safeEmail = email.replace(/[\r\n]/g, '')
        console.log(`[invites] Invite URL for ${safeEmail}: ${inviteUrl}`)
      }

      res.status(201).json({ ok: true, email })
    })
  )

  workspaceRouter.get(
    '/:id/invites',
    asyncHandler(async (req, res) => {
      const user = req.user!
      const workspaceId = req.params.id as string

      await assertWorkspacePermission(user.id, workspaceId, 'members:manage')

      const invites = await prisma.workspaceInvite.findMany({
        where: { workspaceId, acceptedAt: null, expiresAt: { gt: new Date() } },
        select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
        orderBy: { createdAt: 'desc' }
      })

      res.json({ invites })
    })
  )

  workspaceRouter.delete(
    '/:id/invites/:inviteId',
    asyncHandler(async (req, res) => {
      const user = req.user!
      const workspaceId = req.params.id as string

      await assertWorkspacePermission(user.id, workspaceId, 'members:manage')

      const inviteId = req.params.inviteId as string
      await prisma.workspaceInvite.deleteMany({
        where: { id: inviteId, workspaceId }
      })

      void recordAudit({
        workspaceId, actorUserId: user.id, type: 'workspace.invite.delete',
        entityType: 'workspaceInvite', entityId: inviteId,
      })

      res.json({ ok: true })
    })
  )

  workspaceRouter.delete(
    '/:id/members/:userId',
    asyncHandler(async (req, res) => {
      const user = req.user!
      const workspaceId = req.params.id as string
      const targetUserId = req.params.userId as string

      if (targetUserId === user.id) throw new ApiError(400, 'Cannot remove yourself — transfer ownership first')

      await assertWorkspacePermission(user.id, workspaceId, 'members:remove')

      const targetMembership = await prisma.membership.findFirst({ where: { userId: targetUserId, workspaceId } })
      if (!targetMembership) throw new ApiError(404, 'Member not found')

      await prisma.membership.delete({ where: { id: targetMembership.id } })
      // Drop the removed member's cached role so they're denied immediately.
      invalidateWorkspaceMembership(targetUserId, workspaceId)

      void recordAudit({
        workspaceId, actorUserId: user.id, type: 'workspace.member.remove',
        entityType: 'membership', entityId: targetUserId,
        metadata: { memberId: targetUserId, role: targetMembership.role },
      })

      res.json({ ok: true })
    })
  )
}
