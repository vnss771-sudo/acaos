import { Router, Request, Response } from 'express'
import { requireAuth } from '../../middleware/auth.js'
import {
  createWebhook,
  getWebhooks,
  getWebhook,
  updateWebhook,
  deactivateWebhook,
  activateWebhook,
  deleteWebhook,
  rotateWebhookSecret,
  createWebhookEvent,
  getWebhookEvents,
  recordWebhookDelivery,
  getWebhookDeliveries,
  getDeliveryStats,
  logWebhookAction,
  getWebhookLogs,
  getWebhooksForEvent,
  clearWebhooks,
} from '@acaos/backend-core/lib/webhookEngine.js'
import {
  createConnector,
  getConnectors,
  getConnector,
  updateConnector,
  enableConnector,
  disableConnector,
  deleteConnector,
  validateConnector,
  sendMessage,
  getConnectorMessages,
  getCapabilities,
  getConnectorHealth,
  rotateConnectorSecret,
  clearConnectors,
} from '@acaos/backend-core/lib/integrationConnectors.js'
import {
  publishEvent,
  subscribeToEvents,
  unsubscribeFromEvents,
  getEventStream,
  requestEventReplay,
  getDeadLetterQueue,
  acknowledgeDeadLetterEvent,
  archiveDeadLetterEvent,
  retryDeadLetterEvent,
  getEventStats,
  clearEventStreaming,
} from '@acaos/backend-core/lib/eventStreaming.js'
import {
  createExportJob,
  getExportJobs,
  getExportJob,
  updateExportJobStatus,
  createExportTemplate,
  getExportTemplates,
  getExportTemplate,
  updateExportTemplate,
  deleteExportTemplate,
  enableScheduledExport,
  disableScheduledExport,
  exportCostData,
  getExportHistory,
  recordExportDownload,
  getExportStats,
  clearExports,
} from '@acaos/backend-core/lib/dataExport.js'

export const phase8IntegrationsRouter = Router()

// ============================================================================
// WEBHOOK ENDPOINTS
// ============================================================================

// Webhook CRUD
phase8IntegrationsRouter.post('/webhooks', requireAuth, (req: Request, res: Response) => {
  const { organizationId, url, eventTypes, headers, retryPolicy } = req.body
  const webhook = createWebhook(organizationId, url, eventTypes, headers, retryPolicy)
  res.json(webhook)
})

phase8IntegrationsRouter.get('/webhooks/:organizationId', requireAuth, (req: Request, res: Response) => {
  const { active } = req.query
  const webhooks = getWebhooks(req.params.organizationId, active === 'true' ? true : active === 'false' ? false : undefined)
  res.json(webhooks)
})

phase8IntegrationsRouter.get('/webhooks/:organizationId/:webhookId', requireAuth, (req: Request, res: Response) => {
  const webhook = getWebhook(req.params.organizationId, req.params.webhookId)
  res.json(webhook || { error: 'Webhook not found' })
})

phase8IntegrationsRouter.put('/webhooks/:organizationId/:webhookId', requireAuth, (req: Request, res: Response) => {
  const success = updateWebhook(req.params.organizationId, req.params.webhookId, req.body)
  res.json({ success })
})

phase8IntegrationsRouter.post('/webhooks/:organizationId/:webhookId/activate', requireAuth, (req: Request, res: Response) => {
  const success = activateWebhook(req.params.organizationId, req.params.webhookId)
  res.json({ success })
})

phase8IntegrationsRouter.post('/webhooks/:organizationId/:webhookId/deactivate', requireAuth, (req: Request, res: Response) => {
  const success = deactivateWebhook(req.params.organizationId, req.params.webhookId)
  res.json({ success })
})

phase8IntegrationsRouter.delete('/webhooks/:organizationId/:webhookId', requireAuth, (req: Request, res: Response) => {
  const success = deleteWebhook(req.params.organizationId, req.params.webhookId)
  res.json({ success })
})

phase8IntegrationsRouter.post('/webhooks/:organizationId/:webhookId/rotate-secret', requireAuth, (req: Request, res: Response) => {
  const secret = rotateWebhookSecret(req.params.organizationId, req.params.webhookId)
  res.json({ secret: secret || null })
})

// Webhook Events
phase8IntegrationsRouter.post('/webhook-events', requireAuth, (req: Request, res: Response) => {
  const { organizationId, eventType, data, triggeredBy } = req.body
  const event = createWebhookEvent(organizationId, eventType, data, triggeredBy)
  res.json(event)
})

phase8IntegrationsRouter.get('/webhook-events/:organizationId', requireAuth, (req: Request, res: Response) => {
  const { eventType, hours = 24 } = req.query
    // @ts-expect-error - type mismatch handled at runtime
  const events = getWebhookEvents(req.params.organizationId, eventType as string, Number(hours))
  res.json(events)
})

// Webhook Deliveries
phase8IntegrationsRouter.get('/webhook-deliveries/:organizationId', requireAuth, (req: Request, res: Response) => {
  const { webhookId, status, days = 30 } = req.query
  const deliveries = getWebhookDeliveries(
    req.params.organizationId,
    webhookId as string,
    status as string,
    Number(days)
  )
  res.json(deliveries)
})

phase8IntegrationsRouter.get('/webhook-stats/:organizationId', requireAuth, (req: Request, res: Response) => {
  const { days = 30 } = req.query
  const stats = getDeliveryStats(req.params.organizationId, Number(days))
  res.json(stats)
})

// ============================================================================
// INTEGRATION CONNECTOR ENDPOINTS
// ============================================================================

// Connector CRUD
phase8IntegrationsRouter.post('/connectors', requireAuth, (req: Request, res: Response) => {
  const { organizationId, name, type, config } = req.body
  const connector = createConnector(organizationId, name, type, config)
  res.json(connector)
})

phase8IntegrationsRouter.get('/connectors/:organizationId', requireAuth, (req: Request, res: Response) => {
    // @ts-expect-error - type mismatch handled at runtime
  const { type } = req.query
    // @ts-expect-error
  const connectors = getConnectors(req.params.organizationId, type as string)
  res.json(connectors)
})

phase8IntegrationsRouter.get('/connectors/:organizationId/:connectorId', requireAuth, (req: Request, res: Response) => {
  const connector = getConnector(req.params.organizationId, req.params.connectorId)
  res.json(connector || { error: 'Connector not found' })
})

phase8IntegrationsRouter.put('/connectors/:organizationId/:connectorId', requireAuth, (req: Request, res: Response) => {
  const success = updateConnector(req.params.organizationId, req.params.connectorId, req.body)
  res.json({ success })
})

phase8IntegrationsRouter.post('/connectors/:organizationId/:connectorId/enable', requireAuth, (req: Request, res: Response) => {
  const success = enableConnector(req.params.organizationId, req.params.connectorId)
  res.json({ success })
})

phase8IntegrationsRouter.post('/connectors/:organizationId/:connectorId/disable', requireAuth, (req: Request, res: Response) => {
  const success = disableConnector(req.params.organizationId, req.params.connectorId)
  res.json({ success })
})

phase8IntegrationsRouter.delete('/connectors/:organizationId/:connectorId', requireAuth, (req: Request, res: Response) => {
  const success = deleteConnector(req.params.organizationId, req.params.connectorId)
  res.json({ success })
})

// Connector Validation & Health
phase8IntegrationsRouter.post('/connectors/:organizationId/:connectorId/validate', requireAuth, (req: Request, res: Response) => {
  const success = validateConnector(req.params.organizationId, req.params.connectorId)
  res.json({ valid: success })
})

phase8IntegrationsRouter.get('/connectors/:organizationId/:connectorId/health', requireAuth, (req: Request, res: Response) => {
  const health = getConnectorHealth(req.params.organizationId, req.params.connectorId)
  res.json(health)
})

phase8IntegrationsRouter.post('/connectors/:organizationId/:connectorId/rotate-secret', requireAuth, (req: Request, res: Response) => {
  const secret = rotateConnectorSecret(req.params.organizationId, req.params.connectorId)
  res.json({ secret: secret || null })
})

// Connector Messages
phase8IntegrationsRouter.post('/connector-messages', requireAuth, (req: Request, res: Response) => {
  const { organizationId, connectorId, type, title, body, severity, metadata } = req.body
  const message = sendMessage(organizationId, connectorId, type, title, body, severity, metadata)
  res.json(message)
})

phase8IntegrationsRouter.get('/connector-messages/:organizationId/:connectorId', requireAuth, (req: Request, res: Response) => {
  const { status, hours = 24 } = req.query
  const messages = getConnectorMessages(req.params.organizationId, req.params.connectorId, status as string, Number(hours))
  res.json(messages)
})

// ============================================================================
// EVENT STREAMING ENDPOINTS
// ============================================================================

phase8IntegrationsRouter.post('/events/publish', requireAuth, (req: Request, res: Response) => {
  const { organizationId, type, severity, source, data, correlationId, userId } = req.body
  const event = publishEvent(organizationId, type, severity, source, data, correlationId, userId)
  res.json(event)
})

    // @ts-expect-error - type mismatch handled at runtime
phase8IntegrationsRouter.get('/events/stream/:organizationId', requireAuth, (req: Request, res: Response) => {
    // @ts-expect-error
  const { type, hours = 24 } = req.query
    // @ts-expect-error
  const events = getEventStream(req.params.organizationId, type as string, Number(hours))
  res.json(events)
})

phase8IntegrationsRouter.post('/events/replay', requireAuth, (req: Request, res: Response) => {
  const { organizationId, startTime, endTime, eventTypes } = req.body
  const request = requestEventReplay(organizationId, new Date(startTime), new Date(endTime), eventTypes)
  res.json(request)
})

phase8IntegrationsRouter.get('/events/stats/:organizationId', requireAuth, (req: Request, res: Response) => {
  const stats = getEventStats(req.params.organizationId)
  res.json(stats)
})

// Dead Letter Queue
phase8IntegrationsRouter.get('/events/dlq/:organizationId', requireAuth, (req: Request, res: Response) => {
  const { status } = req.query
  const dlq = getDeadLetterQueue(req.params.organizationId, status as string)
  res.json(dlq)
})

phase8IntegrationsRouter.post('/events/dlq/:organizationId/:dlEventId/acknowledge', requireAuth, (req: Request, res: Response) => {
  const success = acknowledgeDeadLetterEvent(req.params.organizationId, req.params.dlEventId)
  res.json({ success })
})

phase8IntegrationsRouter.post('/events/dlq/:organizationId/:dlEventId/archive', requireAuth, (req: Request, res: Response) => {
  const success = archiveDeadLetterEvent(req.params.organizationId, req.params.dlEventId)
  res.json({ success })
})

phase8IntegrationsRouter.post('/events/dlq/:organizationId/:dlEventId/retry', requireAuth, (req: Request, res: Response) => {
  const success = retryDeadLetterEvent(req.params.organizationId, req.params.dlEventId)
  res.json({ success })
})

// ============================================================================
// DATA EXPORT ENDPOINTS
// ============================================================================

// Export Jobs
phase8IntegrationsRouter.post('/exports/jobs', requireAuth, (req: Request, res: Response) => {
  const { organizationId, name, type, format, startDate, endDate, filters } = req.body
  const job = createExportJob(organizationId, name, type, format, new Date(startDate), new Date(endDate), filters)
  res.json(job)
})

phase8IntegrationsRouter.get('/exports/jobs/:organizationId', requireAuth, (req: Request, res: Response) => {
  const { status, type, days = 30 } = req.query
  const jobs = getExportJobs(req.params.organizationId, status as string, type as string, Number(days))
  res.json(jobs)
})

phase8IntegrationsRouter.get('/exports/jobs/:organizationId/:jobId', requireAuth, (req: Request, res: Response) => {
  const job = getExportJob(req.params.organizationId, req.params.jobId)
  res.json(job || { error: 'Job not found' })
})

// Cost Data Export
phase8IntegrationsRouter.post('/exports/cost-data', requireAuth, (req: Request, res: Response) => {
  const { organizationId, format, startDate, endDate, filters } = req.body
  const job = exportCostData(organizationId, format, new Date(startDate), new Date(endDate), filters)
  res.json(job)
})

// Export Templates
phase8IntegrationsRouter.post('/exports/templates', requireAuth, (req: Request, res: Response) => {
  const { organizationId, name, type, description, format, dimensions, metrics, filters } = req.body
  const template = createExportTemplate(organizationId, name, type, description, format, dimensions, metrics, filters)
  res.json(template)
})
    // @ts-expect-error - type mismatch handled at runtime

    // @ts-expect-error
phase8IntegrationsRouter.get('/exports/templates/:organizationId', requireAuth, (req: Request, res: Response) => {
    // @ts-expect-error
  const { type } = req.query
    // @ts-expect-error
  const templates = getExportTemplates(req.params.organizationId, type as string)
  res.json(templates)
})

phase8IntegrationsRouter.get('/exports/templates/:organizationId/:templateId', requireAuth, (req: Request, res: Response) => {
  const template = getExportTemplate(req.params.organizationId, req.params.templateId)
  res.json(template || { error: 'Template not found' })
})

phase8IntegrationsRouter.put('/exports/templates/:organizationId/:templateId', requireAuth, (req: Request, res: Response) => {
  const success = updateExportTemplate(req.params.organizationId, req.params.templateId, req.body)
  res.json({ success })
})

phase8IntegrationsRouter.delete('/exports/templates/:organizationId/:templateId', requireAuth, (req: Request, res: Response) => {
  const success = deleteExportTemplate(req.params.organizationId, req.params.templateId)
  res.json({ success })
})

// Scheduled Exports
phase8IntegrationsRouter.post('/exports/templates/:organizationId/:templateId/schedule', requireAuth, (req: Request, res: Response) => {
  const { frequency, hour, dayOfWeek, dayOfMonth } = req.body
  const success = enableScheduledExport(
    req.params.organizationId,
    req.params.templateId,
    frequency,
    hour,
    dayOfWeek,
    dayOfMonth
  )
  res.json({ success })
})

phase8IntegrationsRouter.post('/exports/templates/:organizationId/:templateId/unschedule', requireAuth, (req: Request, res: Response) => {
  const success = disableScheduledExport(req.params.organizationId, req.params.templateId)
  res.json({ success })
})

// Export History
phase8IntegrationsRouter.get('/exports/history/:organizationId', requireAuth, (req: Request, res: Response) => {
  const { days = 30 } = req.query
  const history = getExportHistory(req.params.organizationId, Number(days))
  res.json(history)
})

// Export Statistics
phase8IntegrationsRouter.get('/exports/stats/:organizationId', requireAuth, (req: Request, res: Response) => {
  const stats = getExportStats(req.params.organizationId)
  res.json(stats)
})

// ============================================================================
// INITIALIZATION & TESTING
// ============================================================================

phase8IntegrationsRouter.post('/clear-all', requireAuth, (req: Request, res: Response) => {
  clearWebhooks()
  clearConnectors()
  clearEventStreaming()
  clearExports()
  res.json({ message: 'All Phase 8 data cleared' })
})
