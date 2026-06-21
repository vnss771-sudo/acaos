import { Router } from 'express'
import { requireAuth, requireVerifiedForMutation } from '../../middleware/auth.js'
import { registerCrudRoutes } from './crud.js'
import { registerDiscoveryRoutes } from './discovery.js'
import { registerScoringRoutes } from './scoring.js'
import { registerIntentRoutes } from './intents.js'
import { registerEnrichmentRoutes } from './enrichment.js'

// Re-exported for any in-package importers and to preserve the original public
// surface of routes/prospects.ts.
export { normalizeDomain } from './helpers.js'

export const prospectsRouter = Router()
prospectsRouter.use(requireAuth)
prospectsRouter.use(requireVerifiedForMutation)

// Routes are registered in their original declaration order so Express keeps
// matching them identically (literal GET paths before GET /:id, etc.).
registerCrudRoutes(prospectsRouter)
registerDiscoveryRoutes(prospectsRouter)
registerScoringRoutes(prospectsRouter)
registerIntentRoutes(prospectsRouter)
registerEnrichmentRoutes(prospectsRouter)
