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
      // Set by requireIngestKeyOrAuth (routes/outcomes.ts) when a request is
      // authenticated via an ingest API key: the resolved workspace and a flag
      // marking the API-key path. Optional because the JWT path leaves them unset.
      resolvedWorkspaceId?: string
      resolvedViaApiKey?: boolean
    }
  }
}

export {}
