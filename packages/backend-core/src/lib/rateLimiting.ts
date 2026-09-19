// Phase 4.9: Dynamic rate limiting with token bucket algorithm.
// Fair request allocation with priority queuing and time-of-day multipliers.

import { logger } from './logger.js'

export type Priority = 'critical' | 'normal' | 'bulk'
export type TimeOfDay = '00:00-06:00' | '06:00-09:00' | '09:00-17:00' | '17:00-20:00' | '20:00-24:00'

export interface RateLimitBucket {
  id: string
  workspaceId: string
  teamId?: string
  endpoint?: string
  capacity: number // max tokens
  refillRate: number // tokens per second
  tokens: number // current tokens
  lastRefillAt: Date
  priority: Priority
  createdAt: Date
  updatedAt: Date
}

export interface QueuedRequest {
  id: string
  requestId: string
  workspaceId: string
  teamId?: string
  endpoint: string
  priority: Priority
  queuedAt: Date
  estimatedWaitMs: number
  timeout: number
}

export interface RateLimitStatus {
  bucketId: string
  tokens: number
  capacity: number
  refillRate: number
  percentageAvailable: number
  requestsInQueue: number
  estimatedWaitMs: number
  status: 'available' | 'limited' | 'queued' | 'exceeded'
}

export interface TimeMultiplier {
  timeWindow: TimeOfDay
  refillMultiplier: number // how many more/fewer tokens to add
  costMultiplier: number // how much more/less this costs
}

// Storage
const buckets = new Map<string, RateLimitBucket>()
const requestQueues = new Map<string, QueuedRequest[]>()
const timeMultipliers = new Map<string, TimeMultiplier[]>()
const MAX_QUEUE_SIZE = 100000

/**
 * Create a rate limit bucket for workspace/team/endpoint.
 */
export function createRateLimitBucket(
  workspaceId: string,
  capacity: number,
  refillRate: number,
  teamId?: string,
  endpoint?: string,
  priority: Priority = 'normal'
): RateLimitBucket {
  const bucket: RateLimitBucket = {
    id: `bucket-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    workspaceId,
    teamId,
    endpoint,
    capacity,
    refillRate,
    tokens: capacity, // start with full capacity
    lastRefillAt: new Date(),
    priority,
    createdAt: new Date(),
    updatedAt: new Date(),
  }

  const key = bucketKey(workspaceId, teamId, endpoint)
  buckets.set(key, bucket)

  logger.info('rate limit bucket created', {
    workspaceId,
    teamId,
    endpoint,
    capacity,
    refillRate,
  })

  return bucket
}

/**
 * Get rate limit bucket.
 */
export function getBucket(
  workspaceId: string,
  teamId?: string,
  endpoint?: string
): RateLimitBucket | null {
  const key = bucketKey(workspaceId, teamId, endpoint)
  return buckets.get(key) || null
}

/**
 * Try to consume tokens from bucket.
 * Returns true if tokens available, false if would exceed limit.
 */
export function consumeTokens(
  workspaceId: string,
  tokensRequired: number,
  teamId?: string,
  endpoint?: string
): boolean {
  const bucket = getBucket(workspaceId, teamId, endpoint)
  if (!bucket) {
    return false // No bucket configured
  }

  // Refill tokens based on time elapsed
  refillTokens(bucket)

  if (bucket.tokens >= tokensRequired) {
    bucket.tokens -= tokensRequired
    bucket.updatedAt = new Date()
    return true
  }

  return false
}

/**
 * Get current rate limit status.
 */
export function getRateLimitStatus(
  workspaceId: string,
  teamId?: string,
  endpoint?: string
): RateLimitStatus {
  const bucket = getBucket(workspaceId, teamId, endpoint)

  if (!bucket) {
    return {
      bucketId: '',
      tokens: 0,
      capacity: 0,
      refillRate: 0,
      percentageAvailable: 0,
      requestsInQueue: 0,
      estimatedWaitMs: 0,
      status: 'exceeded',
    }
  }

  refillTokens(bucket)

  const queue = getQueue(workspaceId, teamId, endpoint)
  const percentageAvailable = (bucket.tokens / bucket.capacity) * 100

  let status: 'available' | 'limited' | 'queued' | 'exceeded' = 'available'
  if (percentageAvailable < 10) {
    status = 'exceeded'
  } else if (percentageAvailable < 25) {
    status = 'limited'
  } else if (queue.length > 0) {
    status = 'queued'
  }

  const avgWaitPerRequest = bucket.refillRate > 0 ? (1 / bucket.refillRate) * 1000 : 0
  const estimatedWaitMs = queue.length * avgWaitPerRequest

  return {
    bucketId: bucket.id,
    tokens: Math.floor(bucket.tokens),
    capacity: bucket.capacity,
    refillRate: bucket.refillRate,
    percentageAvailable: Math.round(percentageAvailable * 100) / 100,
    requestsInQueue: queue.length,
    estimatedWaitMs: Math.round(estimatedWaitMs),
    status,
  }
}

/**
 * Queue a request for later execution.
 */
export function queueRequest(
  requestId: string,
  workspaceId: string,
  endpoint: string,
  priority: Priority = 'normal',
  teamId?: string,
  timeout: number = 300000 // 5 minutes default
): QueuedRequest {
  const request: QueuedRequest = {
    id: `queued-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    requestId,
    workspaceId,
    teamId,
    endpoint,
    priority,
    queuedAt: new Date(),
    estimatedWaitMs: 0,
    timeout,
  }

  const queue = getQueue(workspaceId, teamId, endpoint)
  queue.push(request)

  // Keep queues bounded
  if (queue.length > MAX_QUEUE_SIZE) {
    // Remove oldest non-critical requests
    queue.sort((a, b) => {
      if (a.priority !== b.priority) {
        return getPriorityScore(b.priority) - getPriorityScore(a.priority)
      }
      return a.queuedAt.getTime() - b.queuedAt.getTime()
    })
    queue.splice(MAX_QUEUE_SIZE / 2)
  }

  logger.info('request queued', {
    workspaceId,
    endpoint,
    priority,
    queueLength: queue.length,
  })

  return request
}

/**
 * Get queued requests for workspace/team/endpoint.
 */
export function getQueuedRequests(
  workspaceId: string,
  teamId?: string,
  endpoint?: string,
  limit: number = 50
): QueuedRequest[] {
  const queue = getQueue(workspaceId, teamId, endpoint)
  return queue.slice(-limit).reverse()
}

/**
 * Dequeue a request (it was processed).
 */
export function dequeueRequest(
  workspaceId: string,
  requestId: string,
  teamId?: string,
  endpoint?: string
): boolean {
  const queue = getQueue(workspaceId, teamId, endpoint)
  const idx = queue.findIndex((r) => r.requestId === requestId)
  if (idx < 0) return false

  queue.splice(idx, 1)
  return true
}

/**
 * Set time-of-day rate multipliers.
 */
export function setTimeMultipliers(workspaceId: string, multipliers: TimeMultiplier[]): TimeMultiplier[] {
  timeMultipliers.set(workspaceId, multipliers)

  logger.info('time multipliers set', {
    workspaceId,
    windows: multipliers.length,
  })

  return multipliers
}

/**
 * Get time-of-day multiplier for current time.
 */
export function getTimeMultiplier(workspaceId: string): TimeMultiplier {
  const multipliers = timeMultipliers.get(workspaceId) || getDefaultTimeMultipliers()
  const now = new Date()
  const hour = now.getHours()

  let window: TimeOfDay
  if (hour < 6) {
    window = '00:00-06:00'
  } else if (hour < 9) {
    window = '06:00-09:00'
  } else if (hour < 17) {
    window = '09:00-17:00'
  } else if (hour < 20) {
    window = '17:00-20:00'
  } else {
    window = '20:00-24:00'
  }

  return multipliers.find((m) => m.timeWindow === window) || getDefaultTimeMultipliers()[0]
}

/**
 * Get effective refill rate accounting for time multiplier.
 */
export function getEffectiveRefillRate(workspaceId: string, baseRate: number): number {
  const multiplier = getTimeMultiplier(workspaceId)
  return baseRate * multiplier.refillMultiplier
}

/**
 * Get effective cost multiplier for current time.
 */
export function getEffectiveCostMultiplier(workspaceId: string): number {
  const multiplier = getTimeMultiplier(workspaceId)
  return multiplier.costMultiplier
}

/**
 * Update bucket refill rate (e.g., due to budget change).
 */
export function updateBucketRefillRate(
  workspaceId: string,
  newRefillRate: number,
  teamId?: string,
  endpoint?: string
): boolean {
  const bucket = getBucket(workspaceId, teamId, endpoint)
  if (!bucket) return false

  bucket.refillRate = newRefillRate
  bucket.updatedAt = new Date()

  logger.info('bucket refill rate updated', {
    workspaceId,
    teamId,
    endpoint,
    newRate: newRefillRate,
  })

  return true
}

/**
 * Get rate limit metrics for workspace.
 */
export function getRateLimitMetrics(workspaceId: string): {
  totalBuckets: number
  totalQueuedRequests: number
  averageTokenPercentage: number
  criticalBuckets: number
} {
  let totalBuckets = 0
  let totalTokenPercentage = 0
  let criticalBuckets = 0
  let totalQueuedRequests = 0

  for (const [key, bucket] of buckets) {
    if (!key.startsWith(workspaceId)) continue

    totalBuckets++
    refillTokens(bucket)
    const percentage = (bucket.tokens / bucket.capacity) * 100
    totalTokenPercentage += percentage

    if (percentage < 10) {
      criticalBuckets++
    }

    const queue = getQueue(workspaceId, undefined, undefined)
    totalQueuedRequests += queue.length
  }

  return {
    totalBuckets,
    totalQueuedRequests,
    averageTokenPercentage: totalBuckets > 0 ? totalTokenPercentage / totalBuckets : 0,
    criticalBuckets,
  }
}

/**
 * Clear rate limiting data (for testing).
 */
export function clearRateLimits(): void {
  buckets.clear()
  requestQueues.clear()
  timeMultipliers.clear()
}

// Helpers

function bucketKey(workspaceId: string, teamId?: string, endpoint?: string): string {
  return `${workspaceId}:${teamId || '*'}:${endpoint || '*'}`
}

function getQueue(workspaceId: string, teamId?: string, endpoint?: string): QueuedRequest[] {
  const key = bucketKey(workspaceId, teamId, endpoint)
  if (!requestQueues.has(key)) {
    requestQueues.set(key, [])
  }
  return requestQueues.get(key)!
}

function refillTokens(bucket: RateLimitBucket): void {
  const now = new Date()
  const secondsElapsed = (now.getTime() - bucket.lastRefillAt.getTime()) / 1000
  const tokensToAdd = secondsElapsed * bucket.refillRate

  bucket.tokens = Math.min(bucket.capacity, bucket.tokens + tokensToAdd)
  bucket.lastRefillAt = now
}

function getPriorityScore(priority: Priority): number {
  return { critical: 3, normal: 2, bulk: 1 }[priority] || 0
}

function getDefaultTimeMultipliers(): TimeMultiplier[] {
  return [
    { timeWindow: '00:00-06:00', refillMultiplier: 0.5, costMultiplier: 0.5 },
    { timeWindow: '06:00-09:00', refillMultiplier: 1.0, costMultiplier: 1.0 },
    { timeWindow: '09:00-17:00', refillMultiplier: 1.5, costMultiplier: 1.5 },
    { timeWindow: '17:00-20:00', refillMultiplier: 1.0, costMultiplier: 1.0 },
    { timeWindow: '20:00-24:00', refillMultiplier: 0.7, costMultiplier: 0.7 },
  ]
}
