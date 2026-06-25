import { Router } from 'express'
import { requireAuth, requireVerifiedForMutationExcept } from '../../middleware/auth.js'
import { registerCoreRoutes } from './core.js'
import { registerMemberRoutes } from './members.js'
import { registerApiKeyRoutes } from './apiKeys.js'
import { registerEmailConfigRoutes } from './emailConfig.js'
import { registerIcpRoutes } from './icp.js'
import { registerComplianceRoutes } from './compliance.js'

export const workspaceRouter = Router()
workspaceRouter.use(requireAuth)
// Gate every workspace mutation behind a verified email EXCEPT the onboarding
// wizard's self-config (PUT /:id/icp, POST /:id/seed) so a new user can finish
// setup before verifying. Member/api-key/email-config/workspace-create mutations
// stay gated.
workspaceRouter.use(requireVerifiedForMutationExcept(/\/icp$/, /\/seed$/))

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
registerComplianceRoutes(workspaceRouter)
