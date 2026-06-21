import { Router } from 'express'
import { requireAuth } from '../../middleware/auth.js'
import { registerCoreRoutes } from './core.js'
import { registerMemberRoutes } from './members.js'
import { registerApiKeyRoutes } from './apiKeys.js'
import { registerEmailConfigRoutes } from './emailConfig.js'
import { registerIcpRoutes } from './icp.js'

export const workspaceRouter = Router()
workspaceRouter.use(requireAuth)

// Routes are registered so Express keeps matching them identically to the
// pre-split router. The route paths are mutually distinct (literal GET / and
// GET /:id both live in core and are registered in their original order; every
// other route carries an extra path segment), so grouping by concern does not
// change which handler wins for any request.
registerCoreRoutes(workspaceRouter)
registerMemberRoutes(workspaceRouter)
registerEmailConfigRoutes(workspaceRouter)
registerIcpRoutes(workspaceRouter)
registerApiKeyRoutes(workspaceRouter)
