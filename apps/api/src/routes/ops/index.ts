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
import { phase47AnalyticsRouter } from './phase4-7-analytics.js'
import { phase48BudgetsRouter } from './phase4-8-budgets.js'
import { phase49RateLimitRouter } from './phase4-9-ratelimit.js'
import { phase5OptimizationRouter } from './phase5-optimization.js'
import { phase6GovernanceRouter } from './phase6-governance.js'
import { phase7MonitoringRouter } from './phase7-monitoring.js'
import { phase8IntegrationsRouter } from './phase8-integrations.js'
import { phase9AnalyticsRouter } from './phase9-analytics.js'

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
// Phase 4.7: Added analytics endpoints for anomaly detection and cost optimization.
// Phase 4.8: Added budget management and cost enforcement endpoints.
// Phase 4.9: Added dynamic rate limiting and feature access control endpoints.
// Phase 5: Added advanced cost optimization and FinOps intelligence endpoints.
// Phase 6: Added enterprise governance, RBAC, organizational hierarchy, and analytics endpoints.
// Phase 7: Added real-time monitoring, chargeback billing, and self-service portal endpoints.
// Phase 8: Added integration connectors, event streaming, webhook infrastructure, and data export endpoints.
// Phase 9: Added advanced analytics, ML pipelines, forecasting, anomaly detection, and recommendation engine.
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
opsRouter.use('/analytics', phase47AnalyticsRouter)
opsRouter.use('/budgets', phase48BudgetsRouter)
opsRouter.use('/ratelimit', phase49RateLimitRouter)
opsRouter.use('/optimization', phase5OptimizationRouter)
opsRouter.use('/governance', phase6GovernanceRouter)
opsRouter.use('/monitoring', phase7MonitoringRouter)
opsRouter.use('/integrations', phase8IntegrationsRouter)
opsRouter.use('/analytics', phase9AnalyticsRouter)
