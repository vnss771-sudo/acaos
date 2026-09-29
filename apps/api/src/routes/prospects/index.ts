import { Router } from 'express'
import { requireAuth, requireVerifiedForMutation } from '../../middleware/auth.js'
import { registerCrudRoutes } from './crud.js'
import { registerDiscoveryRoutes } from './discovery.js'
import { registerScoringRoutes } from './scoring.js'
import { registerIntentRoutes } from './intents.js'
import { registerEnrichmentRoutes } from './enrichment.js'

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
