import { Router } from 'express'
import { crewRouter } from './crew.js'
import { opsJobsRouter } from './jobs.js'
import { shiftsRouter } from './shifts.js'
import { clockRouter } from './clock.js'
import { rosterRouter } from './roster.js'
import { alertsRouter } from './alerts.js'
import { fatigueRouter } from './fatigue.js'
import { adminRouter } from './admin.js'
import { performanceRouter } from './performance.js'
import { optimizationRouter } from './optimization.js'
import { tracingRouter } from './tracing.js'
import { quotasRouter } from './quotas.js'
import { phase45AlertsRouter } from './phase4-5-alerts.js'
import { phase46NotificationsRouter } from './phase4-6-notifications.js'

// The Ops module: workspace-scoped field crew / job-site / shift / roster
// management. Each concern is its own router (each already carries its own
// requireAuth/requireVerifiedForMutation and root-level "/" routes), mounted at
// its own prefix here — unlike routes/prospects or routes/workspaces, which
// register handler functions onto one shared router to keep flat URLs, Ops
// endpoints are naturally namespaced (GET /api/ops/crew, POST /api/ops/clock/in,
// …) so separate routers at separate prefixes is the natural fit.
//
// Phase 4.1: Added performance monitoring endpoints for multi-tenant health checks.
// Phase 4.2: Added optimization/indexing endpoints for query and database tuning.
// Phase 4.3: Added distributed tracing endpoints for end-to-end latency analysis.
// Phase 4.4: Added quotas and billing endpoints for workspace cost attribution.
// Phase 4.5: Added alerts and cost forecasting endpoints for proactive recommendations.
// Phase 4.6: Added notification and escalation management endpoints for automation.
export const opsRouter = Router()

opsRouter.use('/crew', crewRouter)
opsRouter.use('/jobs', opsJobsRouter)
opsRouter.use('/shifts', shiftsRouter)
opsRouter.use('/clock', clockRouter)
opsRouter.use('/roster', rosterRouter)
opsRouter.use('/alerts', alertsRouter)
opsRouter.use('/fatigue', fatigueRouter)
opsRouter.use('/admin', adminRouter)
opsRouter.use('/performance', performanceRouter)
opsRouter.use('/optimization', optimizationRouter)
opsRouter.use('/tracing', tracingRouter)
opsRouter.use('/quotas', quotasRouter)
opsRouter.use('/alerts', phase45AlertsRouter)
opsRouter.use('/notifications', phase46NotificationsRouter)
