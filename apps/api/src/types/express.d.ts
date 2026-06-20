// Global Express augmentation: `req.user` is attached by the requireAuth
// middleware and is therefore present on every handler mounted behind it. Typed
// as optional because Express's base Request has no user (unauthed routes, error
// handlers, the middleware chain before requireAuth runs); handlers behind
// requireAuth read it as `req.user!`. This replaces the repeated
// `req.user!` cast that previously obscured the invariant.
import type { AuthUser } from './auth.js'

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser
    }
  }
}

export {}
