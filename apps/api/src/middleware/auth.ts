import type { Request, Response, NextFunction } from 'express'
import { verifyJwt } from '../lib/jwt.js'
import { prisma } from '../lib/prisma.js'

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing bearer token' })
  }

  const token = auth.slice('Bearer '.length)

  let payload
  try {
    payload = verifyJwt(token)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { id: true, email: true, name: true }
    })

    if (!user) {
      return res.status(401).json({ error: 'User not found' })
    }

    ;(req as Request & { user?: typeof user }).user = user
    return next()
  } catch (error) {
    return next(error)
  }
}
