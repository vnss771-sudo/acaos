// Phase 8: Event streaming and pub-sub system for cost events and automation.
// Enables event publication, subscription, replay, and dead letter queue handling.

import { logger } from './logger.js'

export type EventType =
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
  | 'webhook_delivery_failed'
  | 'connector_health_degraded'
  | 'export_completed'
  | 'reconciliation_generated'

export interface StreamEvent {
  id: string
  type: EventType
  organizationId: string
  timestamp: Date
  severity: 'low' | 'medium' | 'high' | 'critical'
  source: string // 'monitoring', 'governance', 'chargeback', 'automation', 'system'
  data: Record<string, unknown>
  correlationId?: string
  userId?: string
}

export interface EventSubscriber {
  id: string
  organizationId: string
  name: string
  eventTypes: EventType[] // Empty array = subscribe to all
  severity?: 'low' | 'medium' | 'high' | 'critical' // Filter by minimum severity
  handler: (event: StreamEvent) => Promise<void> | void
  enabled: boolean
  createdAt: Date
}

export interface DeadLetterEvent {
  id: string
  organizationId: string
  event: StreamEvent
  subscriberId: string
  error: string
  retries: number
  lastAttemptAt: Date
  status: 'pending' | 'acknowledged' | 'archived'
}

export interface EventReplayRequest {
  id: string
  organizationId: string
  startTime: Date
  endTime: Date
  eventTypes?: EventType[]
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  eventsReplayed: number
  createdAt: Date
  completedAt?: Date
  error?: string
}

// Storage
const events = new Map<string, StreamEvent[]>()
const subscribers = new Map<string, EventSubscriber[]>()
const deadLetterQueue = new Map<string, DeadLetterEvent[]>()
const replayRequests = new Map<string, EventReplayRequest[]>()
const subscriberStats = new Map<string, Record<string, unknown>>()

/**
 * Publish event to stream.
 */
export function publishEvent(
  organizationId: string,
  type: EventType,
  severity: 'low' | 'medium' | 'high' | 'critical',
  source: string,
  data: Record<string, unknown>,
  correlationId?: string,
  userId?: string
): StreamEvent {
  const event: StreamEvent = {
    id: `evt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type,
    organizationId,
    timestamp: new Date(),
    severity,
    source,
    data,
    correlationId,
    userId,
  }

  // Store event
  const key = `${organizationId}:events`
  const list = events.get(key) || []
  list.push(event)

  // Keep last 100000 events
  const filtered = list.slice(-100000)
  events.set(key, filtered)

  // Deliver to subscribers
  deliverToSubscribers(organizationId, event)

  logger.info('event published', {
    organizationId,
    eventId: event.id,
    type,
    severity,
    source,
  })

  return event
}

/**
 * Deliver event to matching subscribers.
 */
function deliverToSubscribers(organizationId: string, event: StreamEvent): void {
  const key = `${organizationId}:subscribers`
  const subList = subscribers.get(key) || []

  subList.forEach((sub) => {
    if (!sub.enabled) return

    // Check if event matches subscription criteria
    const typeMatches = sub.eventTypes.length === 0 || sub.eventTypes.includes(event.type)
    const severityMatches = !sub.severity || isHigherOrEqualSeverity(event.severity, sub.severity)

    if (!typeMatches || !severityMatches) return

    // Attempt delivery
    try {
      const result = sub.handler(event)
      if (result instanceof Promise) {
        result.catch((error) => {
          recordDeadLetterEvent(organizationId, sub.id, event, error)
        })
      }
    } catch (error) {
      recordDeadLetterEvent(organizationId, sub.id, event, error)
    }
  })
}

/**
 * Check if severity is higher or equal.
 */
function isHigherOrEqualSeverity(current: string, threshold: string): boolean {
  const levels: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 }
  return (levels[current] ?? 0) >= (levels[threshold] ?? 0)
}

/**
 * Record failed delivery to dead letter queue.
 */
function recordDeadLetterEvent(organizationId: string, subscriberId: string, event: StreamEvent, error: unknown): void {
  const dlEvent: DeadLetterEvent = {
    id: `dl-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    event,
    subscriberId,
    error: error instanceof Error ? error.message : String(error),
    retries: 0,
    lastAttemptAt: new Date(),
    status: 'pending',
  }

  const key = `${organizationId}:dlq`
  const list = deadLetterQueue.get(key) || []
  list.push(dlEvent)

  // Keep last 10000 DL events
  const filtered = list.slice(-10000)
  deadLetterQueue.set(key, filtered)

  logger.warn('event delivery failed - added to DLQ', {
    organizationId,
    subscriberId,
    eventId: event.id,
    error: dlEvent.error,
  })
}

/**
 * Subscribe to events.
 */
export function subscribeToEvents(
  organizationId: string,
  name: string,
  eventTypes: EventType[] = [],
  handler: (event: StreamEvent) => Promise<void> | void,
  severity?: 'low' | 'medium' | 'high' | 'critical'
): EventSubscriber {
  const subscriber: EventSubscriber = {
    id: `sub-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    name,
    eventTypes,
    severity,
    handler,
    enabled: true,
    createdAt: new Date(),
  }

  const key = `${organizationId}:subscribers`
  const list = subscribers.get(key) || []
  list.push(subscriber)
  subscribers.set(key, list)

  logger.info('event subscriber registered', {
    organizationId,
    subscriberId: subscriber.id,
    name,
    eventTypeCount: eventTypes.length,
  })

  return subscriber
}

/**
 * Unsubscribe from events.
 */
export function unsubscribeFromEvents(organizationId: string, subscriberId: string): boolean {
  const key = `${organizationId}:subscribers`
  const list = subscribers.get(key) || []
  const filtered = list.filter((s) => s.id !== subscriberId)
  subscribers.set(key, filtered)

  return filtered.length < list.length
}

/**
 * Get event stream.
 */
export function getEventStream(
  organizationId: string,
  eventType?: EventType,
  hours: number = 24
): StreamEvent[] {
  const key = `${organizationId}:events`
  const list = events.get(key) || []
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000)

  let filtered = list.filter((e) => e.timestamp >= cutoff)
  if (eventType) {
    filtered = filtered.filter((e) => e.type === eventType)
  }

  return filtered
}

/**
 * Request event replay.
 */
export function requestEventReplay(
  organizationId: string,
  startTime: Date,
  endTime: Date,
  eventTypes?: EventType[]
): EventReplayRequest {
  const request: EventReplayRequest = {
    id: `replay-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    startTime,
    endTime,
    eventTypes,
    status: 'pending',
    eventsReplayed: 0,
    createdAt: new Date(),
  }

  // Find events in time range
  const key = `${organizationId}:events`
  const allEvents = events.get(key) || []
  let eventsToReplay = allEvents.filter((e) => e.timestamp >= startTime && e.timestamp <= endTime)

  if (eventTypes && eventTypes.length > 0) {
    eventsToReplay = eventsToReplay.filter((e) => eventTypes.includes(e.type))
  }

  // Simulate replay
  request.status = 'in_progress'
  eventsToReplay.forEach((event) => {
    deliverToSubscribers(organizationId, event)
    request.eventsReplayed++
  })

  request.status = 'completed'
  request.completedAt = new Date()

  const rkey = `${organizationId}:replays`
  const rlist = replayRequests.get(rkey) || []
  rlist.push(request)
  replayRequests.set(rkey, rlist)

  logger.info('event replay completed', {
    organizationId,
    replayId: request.id,
    eventsReplayed: request.eventsReplayed,
  })

  return request
}

/**
 * Get dead letter queue.
 */
export function getDeadLetterQueue(organizationId: string, status?: string): DeadLetterEvent[] {
  const key = `${organizationId}:dlq`
  const list = deadLetterQueue.get(key) || []

  if (status) {
    return list.filter((d) => d.status === status)
  }

  return list
}

/**
 * Acknowledge dead letter event.
 */
export function acknowledgeDeadLetterEvent(organizationId: string, dlEventId: string): boolean {
  const key = `${organizationId}:dlq`
  const list = deadLetterQueue.get(key) || []
  const dlEvent = list.find((d) => d.id === dlEventId)

  if (!dlEvent) return false

  dlEvent.status = 'acknowledged'

  return true
}

/**
 * Archive dead letter event.
 */
export function archiveDeadLetterEvent(organizationId: string, dlEventId: string): boolean {
  const key = `${organizationId}:dlq`
  const list = deadLetterQueue.get(key) || []
  const dlEvent = list.find((d) => d.id === dlEventId)

  if (!dlEvent) return false

  dlEvent.status = 'archived'

  return true
}

/**
 * Retry dead letter event.
 */
export function retryDeadLetterEvent(organizationId: string, dlEventId: string): boolean {
  const key = `${organizationId}:dlq`
  const list = deadLetterQueue.get(key) || []
  const dlEvent = list.find((d) => d.id === dlEventId)

  if (!dlEvent) return false

  dlEvent.retries++
  dlEvent.lastAttemptAt = new Date()
  dlEvent.status = 'pending'

  // Attempt redelivery
  deliverToSubscribers(organizationId, dlEvent.event)

  return true
}

/**
 * Get event streaming statistics.
 */
export function getEventStats(organizationId: string): {
  totalEvents: number
  eventsByType: Record<string, number>
  subscriberCount: number
  deadLetterCount: number
  deadLetterByStatus: Record<string, number>
} {
  const key = `${organizationId}:events`
  const allEvents = events.get(key) || []

  const eventsByType: Record<string, number> = {}
  allEvents.forEach((e) => {
    eventsByType[e.type] = (eventsByType[e.type] ?? 0) + 1
  })

  const skey = `${organizationId}:subscribers`
  const subList = subscribers.get(skey) || []

  const dkey = `${organizationId}:dlq`
  const dlList = deadLetterQueue.get(dkey) || []

  const deadLetterByStatus: Record<string, number> = {}
  dlList.forEach((d) => {
    deadLetterByStatus[d.status] = (deadLetterByStatus[d.status] ?? 0) + 1
  })

  return {
    totalEvents: allEvents.length,
    eventsByType,
    subscriberCount: subList.length,
    deadLetterCount: dlList.length,
    deadLetterByStatus,
  }
}

/**
 * Clear event streaming data (for testing).
 */
export function clearEventStreaming(): void {
  events.clear()
  subscribers.clear()
  deadLetterQueue.clear()
  replayRequests.clear()
  subscriberStats.clear()
}
