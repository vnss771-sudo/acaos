import { Router } from 'express'
import crypto from 'node:crypto'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { isValidEmail, normalizeEmail } from '../lib/validation.js'
import { sendMail, isMailConfigured } from '../services/mail.js'
import type { AuthedRequest } from '../types/auth.js'

export const invitesRouter = Router()

const INVITE_VALID_DAYS = 7

// POST /api/invites — send invite (JWT + owner/admin only)
invitesRouter.post(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const workspaceId = String(req.body?.workspaceId || '').trim()
    const rawEmail = String(req.body?.email || '').trim()
    const role = String(req.body?.role || 'member').trim()

    if (!workspaceId) throw new ApiError(400, 'workspaceId required')
    if (!rawEmail) throw new ApiError(400, 'email required')
    const email = normalizeEmail(rawEmail)
    if (!isValidEmail(email)) throw new ApiError(400, 'Valid email required')
    if (!['member', 'admin'].includes(role)) throw new ApiError(400, 'role must be member or admin')

    const membership = await prisma.membership.findFirst({
      where: { userId: user.id, workspaceId, role: { in: ['owner', 'admin'] } }
    })
    if (!membership) throw new ApiError(403, 'Must be owner or admin to invite members')

    // Check if already a member
    const existing = await prisma.user.findUnique({
      where: { email },
      include: { memberships: { where: { workspaceId } } }
    })
    if (existing?.memberships?.length) {
      throw new ApiError(409, 'This person is already a workspace member')
    }

    const token = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + INVITE_VALID_DAYS * 24 * 60 * 60 * 1000)

    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { name: true }
    })

    const invite = await prisma.workspaceInvite.upsert({
      where: { workspaceId_email: { workspaceId, email } },
      create: { workspaceId, email, role, token, invitedById: user.id, expiresAt },
      update: { token, role, invitedById: user.id, expiresAt, acceptedAt: null }
    })

    if (isMailConfigured()) {
      const acceptUrl = `${process.env.WEB_URL || 'http://localhost:5173'}/invite/${token}`
      await sendMail(
        email,
        `You've been invited to ${workspace?.name ?? 'a workspace'} on ACAOS`,
        `<p>You've been invited to join <strong>${workspace?.name}</strong> on ACAOS as a <strong>${role}</strong>.</p>
         <p><a href="${acceptUrl}">Accept invitation</a></p>
         <p>This link expires in ${INVITE_VALID_DAYS} days.</p>`
      ).catch(() => { /* email delivery is best-effort */ })
    }

    res.status(201).json({ invite: { id: invite.id, email, role, expiresAt: invite.expiresAt, token: isMailConfigured() ? undefined : token } })
  })
)

// GET /api/invites/:token — validate invite (public)
invitesRouter.get(
  '/:token',
  asyncHandler(async (req, res) => {
    const invite = await prisma.workspaceInvite.findUnique({
      where: { token: req.params.token },
      include: { workspace: { select: { name: true, slug: true } } }
    })
    if (!invite) throw new ApiError(404, 'Invite not found or expired')
    if (invite.acceptedAt) throw new ApiError(410, 'Invite already accepted')
    if (invite.expiresAt < new Date()) throw new ApiError(410, 'Invite has expired')

    res.json({
      email: invite.email,
      role: invite.role,
      workspace: invite.workspace,
      expiresAt: invite.expiresAt
    })
  })
)

// POST /api/invites/:token/accept — accept invite (JWT required)
invitesRouter.post(
  '/:token/accept',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user

    const invite = await prisma.workspaceInvite.findUnique({
      where: { token: req.params.token }
    })
    if (!invite) throw new ApiError(404, 'Invite not found')
    if (invite.acceptedAt) throw new ApiError(410, 'Invite already accepted')
    if (invite.expiresAt < new Date()) throw new ApiError(410, 'Invite has expired')
    if (user.email !== invite.email) {
      throw new ApiError(403, `This invite was sent to ${invite.email}. Please log in with that address.`)
    }

    const existingMembership = await prisma.membership.findFirst({
      where: { userId: user.id, workspaceId: invite.workspaceId }
    })
    if (existingMembership) {
      await prisma.workspaceInvite.update({ where: { token: req.params.token }, data: { acceptedAt: new Date() } })
      return res.json({ ok: true, workspaceId: invite.workspaceId, alreadyMember: true })
    }

    await prisma.$transaction([
      prisma.membership.create({
        data: { userId: user.id, workspaceId: invite.workspaceId, role: invite.role }
      }),
      prisma.workspaceInvite.update({
        where: { token: req.params.token },
        data: { acceptedAt: new Date() }
      })
    ])

    res.json({ ok: true, workspaceId: invite.workspaceId })
  })
)

// GET /api/invites?workspaceId — list pending invites (JWT + owner/admin)
invitesRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const workspaceId = String(req.query.workspaceId || '').trim()
    if (!workspaceId) throw new ApiError(400, 'workspaceId required')

    const membership = await prisma.membership.findFirst({
      where: { userId: user.id, workspaceId, role: { in: ['owner', 'admin'] } }
    })
    if (!membership) throw new ApiError(403, 'Access denied')

    const invites = await prisma.workspaceInvite.findMany({
      where: { workspaceId, acceptedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, email: true, role: true, expiresAt: true, createdAt: true }
    })

    res.json({ invites })
  })
)

// DELETE /api/invites/:id — revoke invite (JWT + owner/admin)
invitesRouter.delete(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const invite = await prisma.workspaceInvite.findUnique({ where: { id: req.params.id } })
    if (!invite) throw new ApiError(404, 'Invite not found')

    const membership = await prisma.membership.findFirst({
      where: { userId: user.id, workspaceId: invite.workspaceId, role: { in: ['owner', 'admin'] } }
    })
    if (!membership) throw new ApiError(403, 'Access denied')

    await prisma.workspaceInvite.delete({ where: { id: req.params.id } })
    res.json({ ok: true })
  })
)
