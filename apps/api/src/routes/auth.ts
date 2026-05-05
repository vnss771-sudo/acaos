import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { prisma } from '../lib/prisma.js'
import { signJwt } from '../lib/jwt.js'
import { requireAuth } from '../middleware/auth.js'
import { asyncHandler, ApiError } from '../lib/http.js'
import { buildWorkspaceName, isValidEmail, normalizeEmail, validatePassword } from '../lib/validation.js'
import { resolveUniqueWorkspaceSlug } from '../lib/workspaces.js'
import type { AuthedRequest } from '../types/auth.js'

export const authRouter = Router()

authRouter.post(
  '/signup',
  asyncHandler(async (req, res) => {
    const rawEmail = String(req.body?.email || '')
    const password = String(req.body?.password || '')
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : undefined

    if (!rawEmail || !password) {
      throw new ApiError(400, 'Email and password are required')
    }

    const email = normalizeEmail(rawEmail)
    if (!isValidEmail(email)) {
      throw new ApiError(400, 'Valid email is required')
    }

    const passwordError = validatePassword(password)
    if (passwordError) {
      throw new ApiError(400, passwordError)
    }

    const existing = await prisma.user.findUnique({ where: { email } })
    if (existing) {
      throw new ApiError(409, 'Email already exists')
    }

    const slug = await resolveUniqueWorkspaceSlug(name, email)
    const workspaceName = buildWorkspaceName(name, email)
    const passwordHash = await bcrypt.hash(password, 10)

    const result = await prisma.$transaction(async (tx: any) => {
      const user = await tx.user.create({
        data: {
          email,
          name,
          passwordHash
        },
        select: { id: true, email: true, name: true }
      })

      const workspace = await tx.workspace.create({
        data: {
          name: workspaceName,
          slug
        },
        select: { id: true, name: true, slug: true }
      })

      await tx.membership.create({
        data: {
          userId: user.id,
          workspaceId: workspace.id,
          role: 'owner'
        }
      })

      return { user, workspace }
    })

    const token = signJwt({ userId: result.user.id })
    res.status(201).json({ token, user: result.user, workspace: result.workspace })
  })
)

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const email = normalizeEmail(String(req.body?.email || ''))
    const password = String(req.body?.password || '')

    if (!email || !password) {
      throw new ApiError(400, 'Email and password are required')
    }

    const user = await prisma.user.findUnique({ where: { email } })
    if (!user?.passwordHash) {
      throw new ApiError(401, 'Invalid credentials')
    }

    const ok = await bcrypt.compare(password, user.passwordHash)
    if (!ok) {
      throw new ApiError(401, 'Invalid credentials')
    }

    const token = signJwt({ userId: user.id })
    res.json({ token, user: { id: user.id, email: user.email, name: user.name } })
  })
)

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = (req as AuthedRequest).user
    const workspaces = await prisma.workspace.findMany({
      where: { memberships: { some: { userId: user.id } } },
      select: { id: true, name: true, slug: true },
      orderBy: { createdAt: 'asc' }
    })
    res.json({ user, workspaces })
  })
)
