// Global Express augmentation: `req.user` is attached by the requireAuth
// middleware and is therefore present on every handler mounted behind it. Typed
// as optional because Express's base Request has no user (unauthed routes, error
// handlers, the middleware chain before requireAuth runs); handlers behind
// requireAuth resolve it via `requireUser(req)` (lib/http.ts), which returns a
// non-optional AuthUser or throws a clean 401 — replacing the old `req.user!`
// non-null cast that turned a missing-middleware bug into a runtime NPE.
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
