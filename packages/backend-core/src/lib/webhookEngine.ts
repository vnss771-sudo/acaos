// Phase 8: Webhook engine with event delivery, retry logic, and security signing.
// Enables webhooks to external systems for cost events and automation.

import { logger } from './logger.js'
import crypto from 'crypto'

export type WebhookEventType =
  | 'cost_spike'
  | 'budget_exceeded'
  | 'budget_below_threshold'
  | 'optimization_recommended'
  | 'optimization_completed'
  | 'policy_violation'
  | 'forecast_warning'
  | 'chargeback_issued'
  | 'report_ready'
  | 'alert_created'

export interface Webhook {
  id: string
  organizationId: string
  url: string
  eventTypes: WebhookEventType[]
  secret: string
  active: boolean
  retryPolicy: {
    maxRetries: number
    backoffMultiplier: number // exponential backoff
    initialDelayMs: number
  }
  headers: Record<string, string>
  createdAt: Date
  updatedAt: Date
}

export interface WebhookEvent {
  id: string
  organizationId: string
  eventType: WebhookEventType
  timestamp: Date
  data: Record<string, unknown>
  triggeredBy: string // userId or system
}

export interface WebhookDelivery {
  id: string
  webhookId: string
  organizationId: string
  eventId: string
  eventType: WebhookEventType
  url: string
  payload: string
  status: 'pending' | 'success' | 'failed' | 'retrying'
  statusCode?: number
  responseBody?: string
  attemptCount: number
  lastAttemptAt?: Date
  nextRetryAt?: Date
  deliveredAt?: Date
  error?: string
}

export interface WebhookSecret {
  webhookId: string
  secret: string
  rotatedAt: Date
}

export interface WebhookLog {
  id: string
  organizationId: string
  action: string // 'created', 'activated', 'deactivated', 'deleted', 'secret_rotated'
  webhookId: string
  userId?: string
  timestamp: Date
  details?: Record<string, unknown>
}

// Storage
const webhooks = new Map<string, Webhook[]>()
const webhookEvents = new Map<string, WebhookEvent[]>()
const webhookDeliveries = new Map<string, WebhookDelivery[]>()
const webhookLogs = new Map<string, WebhookLog[]>()

/**
 * Create webhook.
 */
export function createWebhook(
  organizationId: string,
  url: string,
  eventTypes: WebhookEventType[],
  headers: Record<string, string> = {},
  retryPolicy?: Partial<Webhook['retryPolicy']>
): Webhook {
  const secret = crypto.randomBytes(32).toString('hex')

  const webhook: Webhook = {
    id: `webhook-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    url,
    eventTypes,
    secret,
    active: true,
    retryPolicy: {
      maxRetries: 5,
      backoffMultiplier: 2,
      initialDelayMs: 1000,
      ...retryPolicy,
    },
    headers,
    createdAt: new Date(),
    updatedAt: new Date(),
  }

  const list = webhooks.get(organizationId) || []
  list.push(webhook)
  webhooks.set(organizationId, list)

  logWebhookAction(organizationId, 'created', webhook.id, undefined, { url, eventTypes })

  logger.info('webhook created', {
    organizationId,
    webhookId: webhook.id,
    url,
    eventTypeCount: eventTypes.length,
  })

  return webhook
}

/**
 * Get webhooks for organization.
 */
export function getWebhooks(organizationId: string, active?: boolean): Webhook[] {
  const list = webhooks.get(organizationId) || []
  return active !== undefined ? list.filter((w) => w.active === active) : list
}

/**
 * Get webhook by ID.
 */
export function getWebhook(organizationId: string, webhookId: string): Webhook | null {
  const list = webhooks.get(organizationId) || []
  return list.find((w) => w.id === webhookId) || null
}

/**
 * Update webhook.
 */
export function updateWebhook(
  organizationId: string,
  webhookId: string,
  updates: Partial<Webhook>
): boolean {
  const list = webhooks.get(organizationId) || []
  const webhook = list.find((w) => w.id === webhookId)

  if (!webhook) return false

  Object.assign(webhook, { ...updates, updatedAt: new Date() })

  return true
}

/**
 * Deactivate webhook.
 */
export function deactivateWebhook(organizationId: string, webhookId: string): boolean {
  const success = updateWebhook(organizationId, webhookId, { active: false })
  if (success) {
    logWebhookAction(organizationId, 'deactivated', webhookId)
  }
  return success
}

/**
 * Activate webhook.
 */
export function activateWebhook(organizationId: string, webhookId: string): boolean {
  const success = updateWebhook(organizationId, webhookId, { active: true })
  if (success) {
    logWebhookAction(organizationId, 'activated', webhookId)
  }
  return success
}

/**
 * Delete webhook.
 */
export function deleteWebhook(organizationId: string, webhookId: string): boolean {
  const list = webhooks.get(organizationId) || []
  const filtered = list.filter((w) => w.id !== webhookId)
  webhooks.set(organizationId, filtered)

  logWebhookAction(organizationId, 'deleted', webhookId)

  return filtered.length < list.length
}

/**
 * Rotate webhook secret.
 */
export function rotateWebhookSecret(organizationId: string, webhookId: string): string | null {
  const webhook = getWebhook(organizationId, webhookId)
  if (!webhook) return null

  webhook.secret = crypto.randomBytes(32).toString('hex')
  webhook.updatedAt = new Date()

  logWebhookAction(organizationId, 'secret_rotated', webhookId)

  return webhook.secret
}

/**
 * Create webhook event.
 */
export function createWebhookEvent(
  organizationId: string,
  eventType: WebhookEventType,
  data: Record<string, unknown>,
  triggeredBy: string = 'system'
): WebhookEvent {
  const event: WebhookEvent = {
    id: `event-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    eventType,
    timestamp: new Date(),
    data,
    triggeredBy,
  }

  const key = `${organizationId}:events`
  const list = webhookEvents.get(key) || []
  list.push(event)

  // Keep last 10000 events
  const filtered = list.slice(-10000)
  webhookEvents.set(key, filtered)

  logger.info('webhook event created', {
    organizationId,
    eventType,
    triggeredBy,
  })

  return event
}

/**
 * Get webhook events.
 */
export function getWebhookEvents(
  organizationId: string,
  eventType?: WebhookEventType,
  hours: number = 24
): WebhookEvent[] {
  const key = `${organizationId}:events`
  const list = webhookEvents.get(key) || []
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000)

  let filtered = list.filter((e) => e.timestamp >= cutoff)
  if (eventType) {
    filtered = filtered.filter((e) => e.eventType === eventType)
  }

  return filtered
}

/**
 * Generate webhook signature for delivery.
 */
export function generateWebhookSignature(secret: string, payload: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex')
}

/**
 * Record webhook delivery.
 */
export function recordWebhookDelivery(
  webhookId: string,
  organizationId: string,
  eventId: string,
  eventType: WebhookEventType,
  url: string,
  payload: string,
  status: 'pending' | 'success' | 'failed' | 'retrying',
  statusCode?: number,
  responseBody?: string,
  error?: string
): WebhookDelivery {
  const delivery: WebhookDelivery = {
    id: `delivery-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    webhookId,
    organizationId,
    eventId,
    eventType,
    url,
    payload,
    status,
    statusCode,
    responseBody,
    attemptCount: 1,
    lastAttemptAt: new Date(),
    error,
  }

  if (status === 'success') {
    delivery.deliveredAt = new Date()
  }

  const key = `${organizationId}:deliveries`
  const list = webhookDeliveries.get(key) || []
  list.push(delivery)

  // Keep last 50000 deliveries
  const filtered = list.slice(-50000)
  webhookDeliveries.set(key, filtered)

  return delivery
}

/**
 * Get webhook deliveries.
 */
export function getWebhookDeliveries(
  organizationId: string,
  webhookId?: string,
  status?: string,
  days: number = 30
): WebhookDelivery[] {
  const key = `${organizationId}:deliveries`
  const list = webhookDeliveries.get(key) || []
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  let filtered = list.filter((d) => d.lastAttemptAt && d.lastAttemptAt >= cutoff)
  if (webhookId) {
    filtered = filtered.filter((d) => d.webhookId === webhookId)
  }
  if (status) {
    filtered = filtered.filter((d) => d.status === status)
  }

  return filtered
}

/**
 * Get delivery statistics.
 */
export function getDeliveryStats(organizationId: string, days: number = 30): {
  total: number
  successful: number
  failed: number
  retrying: number
  successRate: number
} {
  const deliveries = getWebhookDeliveries(organizationId, undefined, undefined, days)

  const successful = deliveries.filter((d) => d.status === 'success').length
  const failed = deliveries.filter((d) => d.status === 'failed').length
  const retrying = deliveries.filter((d) => d.status === 'retrying').length
  const total = deliveries.length

  return {
    total,
    successful,
    failed,
    retrying,
    successRate: total > 0 ? (successful / total) * 100 : 0,
  }
}

/**
 * Log webhook action.
 */
export function logWebhookAction(
  organizationId: string,
  action: string,
  webhookId: string,
  userId?: string,
  details?: Record<string, unknown>
): void {
  const log: WebhookLog = {
    id: `log-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    action,
    webhookId,
    userId,
    timestamp: new Date(),
    details,
  }

  const key = `${organizationId}:logs`
  const list = webhookLogs.get(key) || []
  list.push(log)

  // Keep last 10000 logs
  const filtered = list.slice(-10000)
  webhookLogs.set(key, filtered)
}

/**
 * Get webhook logs.
 */
export function getWebhookLogs(organizationId: string, days: number = 30): WebhookLog[] {
  const key = `${organizationId}:logs`
  const list = webhookLogs.get(key) || []
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  return list.filter((l) => l.timestamp >= cutoff)
}

/**
 * Get webhooks for event type.
 */
export function getWebhooksForEvent(organizationId: string, eventType: WebhookEventType): Webhook[] {
  const list = getWebhooks(organizationId, true) // Only active webhooks
  return list.filter((w) => w.eventTypes.includes(eventType))
}

/**
 * Clear webhook data (for testing).
 */
export function clearWebhooks(): void {
  webhooks.clear()
  webhookEvents.clear()
  webhookDeliveries.clear()
  webhookLogs.clear()
}
