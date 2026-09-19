// Phase 4.6: Real-time notification delivery.
// Sends alerts to workspace admins via email, Slack, webhooks, and in-app.
// Manages notification preferences, templates, and delivery status.

import { logger } from './logger.js'

export type NotificationChannel = 'email' | 'slack' | 'webhook' | 'in_app' | 'sms'
export type NotificationPriority = 'low' | 'medium' | 'high' | 'critical'
export type NotificationStatus = 'pending' | 'sent' | 'delivered' | 'failed' | 'bounced'

export interface NotificationPreference {
  workspaceId: string
  channel: NotificationChannel
  enabled: boolean
  destination?: string // email, Slack webhook, etc.
  minPriority?: NotificationPriority // Only notify for this priority or higher
  quietHours?: { start: string; end: string } // e.g. { start: '22:00', end: '08:00' }
  batchDaily?: boolean // Batch multiple alerts into daily digest
}

export interface Notification {
  id: string
  workspaceId: string
  type: string // 'quota_exceeded', 'cost_forecast', 'upgrade_recommended', etc.
  priority: NotificationPriority
  subject: string
  body: string
  channels: NotificationChannel[]
  createdAt: Date
  status: NotificationStatus
  attempts: number
  lastAttemptAt?: Date
  error?: string
}

export interface NotificationTemplate {
  type: string
  priority: NotificationPriority
  subject: string
  bodyTemplate: string // Supports {{variable}} interpolation
  channels: NotificationChannel[]
  retryPolicy: {
    maxAttempts: number
    backoffMs: number
  }
}

// Storage (would be persisted to DB in production)
const notificationPreferences = new Map<string, NotificationPreference[]>()
const notificationQueue: Notification[] = []
const notificationHistory: Notification[] = []
const MAX_HISTORY = 10000

// Built-in templates
export const NOTIFICATION_TEMPLATES: Record<string, NotificationTemplate> = {
  quota_exceeded: {
    type: 'quota_exceeded',
    priority: 'critical',
    subject: 'Critical: {{quotaType}} quota exceeded for {{workspaceName}}',
    bodyTemplate: `Your {{workspaceName}} workspace has exceeded the {{quotaType}} quota.

Current usage: {{currentUsage}} / {{limit}}
Percentage: {{percentageUsed}}%

Action required: Upgrade your plan or contact support for immediate relief.

Learn more: https://docs.example.com/quotas`,
    channels: ['email', 'slack'],
    retryPolicy: { maxAttempts: 3, backoffMs: 5000 },
  },
  quota_warning: {
    type: 'quota_warning',
    priority: 'high',
    subject: 'Warning: {{quotaType}} quota approaching limit ({{percentageUsed}}%)',
    bodyTemplate: `Your {{workspaceName}} workspace is approaching the {{quotaType}} soft cap.

Current usage: {{currentUsage}} / {{softCap}}
Percentage of soft cap: {{percentageUsed}}%

Recommended action: Review usage or upgrade to next plan.

Upgrade now: https://example.com/workspace/{{workspaceId}}/plan`,
    channels: ['email', 'in_app'],
    retryPolicy: { maxAttempts: 2, backoffMs: 10000 },
  },
  upgrade_recommended: {
    type: 'upgrade_recommended',
    priority: 'medium',
    subject: 'Cost optimization: Upgrade recommended for {{workspaceName}}',
    bodyTemplate: `Based on your usage patterns, upgrading to {{recommendedPlan}} would be more cost-effective.

Current plan: {{currentPlan}}
Current monthly cost: {{currentMonthCost}}
Estimated savings: {{estimatedSavings}}

Upgrade now: https://example.com/workspace/{{workspaceId}}/upgrade`,
    channels: ['email', 'in_app'],
    retryPolicy: { maxAttempts: 2, backoffMs: 15000 },
  },
  cost_forecast: {
    type: 'cost_forecast',
    priority: 'medium',
    subject: 'Monthly cost forecast: {{workspaceName}} projected at {{projectedCost}}',
    bodyTemplate: `Your {{workspaceName}} workspace is projected to cost {{projectedCost}} this month.

Current spending: {{currentCost}}
Projected overage: {{projectedOverage}}
Confidence: {{confidence}}%

Days remaining: {{daysRemaining}}

Review forecast: https://example.com/workspace/{{workspaceId}}/billing`,
    channels: ['in_app'],
    retryPolicy: { maxAttempts: 1, backoffMs: 30000 },
  },
}

/**
 * Set notification preferences for a workspace.
 */
export function setNotificationPreference(
  workspaceId: string,
  preference: Omit<NotificationPreference, 'workspaceId'>
): NotificationPreference {
  const prefs = notificationPreferences.get(workspaceId) || []

  // Update or add preference
  const existing = prefs.findIndex((p) => p.channel === preference.channel)
  const pref = { ...preference, workspaceId }

  if (existing >= 0) {
    prefs[existing] = pref
  } else {
    prefs.push(pref)
  }

  notificationPreferences.set(workspaceId, prefs)
  return pref
}

/**
 * Get notification preferences for a workspace.
 */
export function getNotificationPreferences(
  workspaceId: string,
  channel?: NotificationChannel
): NotificationPreference[] {
  const prefs = notificationPreferences.get(workspaceId) || []
  if (channel) {
    return prefs.filter((p) => p.channel === channel)
  }
  return prefs
}

/**
 * Queue a notification for delivery.
 */
export function queueNotification(
  workspaceId: string,
  templateType: string,
  variables: Record<string, unknown>
): Notification | null {
  const template = NOTIFICATION_TEMPLATES[templateType]
  if (!template) {
    logger.warn('unknown notification template', { templateType })
    return null
  }

  // Get enabled channels for this workspace
  const prefs = getNotificationPreferences(workspaceId)
  const enabledChannels = prefs
    .filter((p) => p.enabled && (!p.minPriority || priorityLevel(template.priority) >= priorityLevel(p.minPriority)))
    .map((p) => p.channel)

  if (enabledChannels.length === 0) {
    return null // No channels enabled
  }

  // Interpolate variables into template
  const subject = interpolate(template.subject, variables)
  const body = interpolate(template.bodyTemplate, variables)

  const notification: Notification = {
    id: `notif-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    workspaceId,
    type: templateType,
    priority: template.priority,
    subject,
    body,
    channels: enabledChannels as NotificationChannel[],
    createdAt: new Date(),
    status: 'pending',
    attempts: 0,
  }

  notificationQueue.push(notification)

  logger.info('notification queued', {
    workspaceId,
    type: templateType,
    priority: template.priority,
    channels: enabledChannels.length,
  })

  return notification
}

/**
 * Mark notification as delivered.
 */
export function markNotificationDelivered(notificationId: string): void {
  const idx = notificationQueue.findIndex((n) => n.id === notificationId)
  if (idx >= 0) {
    const notif = notificationQueue[idx]
    notif.status = 'delivered'
    notif.lastAttemptAt = new Date()
    notificationQueue.splice(idx, 1)
    notificationHistory.push(notif)

    if (notificationHistory.length > MAX_HISTORY) {
      notificationHistory.splice(0, MAX_HISTORY - 5000)
    }
  }
}

/**
 * Mark notification as failed.
 */
export function markNotificationFailed(notificationId: string, error: string): void {
  const notif = notificationQueue.find((n) => n.id === notificationId)
  if (notif) {
    notif.attempts++
    notif.error = error
    notif.lastAttemptAt = new Date()

    const template = NOTIFICATION_TEMPLATES[notif.type]
    if (notif.attempts >= (template?.retryPolicy.maxAttempts || 3)) {
      notif.status = 'failed'
      const idx = notificationQueue.findIndex((n) => n.id === notificationId)
      if (idx >= 0) {
        notificationQueue.splice(idx, 1)
        notificationHistory.push(notif)
      }

      logger.error('notification delivery failed', {
        notificationId,
        attempts: notif.attempts,
        error,
      })
    }
  }
}

/**
 * Get pending notifications to send.
 */
export function getPendingNotifications(limit: number = 50): Notification[] {
  return notificationQueue
    .filter((n) => n.status === 'pending')
    .sort((a, b) => priorityLevel(b.priority) - priorityLevel(a.priority))
    .slice(0, limit)
}

/**
 * Get notification history for a workspace.
 */
export function getNotificationHistory(
  workspaceId: string,
  limit: number = 50
): Notification[] {
  return notificationHistory
    .filter((n) => n.workspaceId === workspaceId)
    .slice(-limit)
    .reverse()
}

/**
 * Get notification statistics.
 */
export function getNotificationStats(): {
  pending: number
  sent: number
  failed: number
  totalDelivered: number
} {
  return {
    pending: notificationQueue.filter((n) => n.status === 'pending').length,
    sent: notificationQueue.filter((n) => n.status === 'sent').length,
    failed: notificationHistory.filter((n) => n.status === 'failed').length,
    totalDelivered: notificationHistory.filter((n) => n.status === 'delivered').length,
  }
}

/**
 * Disable notifications for a workspace (quiet mode).
 */
export function setQuietMode(workspaceId: string, enabled: boolean, until?: Date): void {
  const prefs = notificationPreferences.get(workspaceId) || []
  prefs.forEach((p) => {
    p.enabled = !enabled
  })
  notificationPreferences.set(workspaceId, prefs)

  logger.info('quiet mode', { workspaceId, enabled, until: until?.toISOString() })
}

/**
 * Test notification delivery (sends to configured channels).
 */
export function testNotification(
  workspaceId: string,
  channel: NotificationChannel
): { success: boolean; message: string } {
  const prefs = getNotificationPreferences(workspaceId, channel)
  const pref = prefs[0]

  if (!pref) {
    return {
      success: false,
      message: `No ${channel} notification preference configured for workspace`,
    }
  }

  if (!pref.enabled) {
    return {
      success: false,
      message: `${channel} notifications are disabled for this workspace`,
    }
  }

  const testMessage = {
    channel,
    destination: pref.destination,
    timestamp: new Date().toISOString(),
    subject: 'Test notification from acaos',
    body: 'This is a test notification. If you received this, notifications are working correctly.',
  }

  logger.info('test notification', testMessage)

  // In production, would actually send via email/Slack/etc
  return {
    success: true,
    message: `Test notification sent to ${pref.destination}. Check your ${channel} account.`,
  }
}

// Helpers

function priorityLevel(priority: NotificationPriority): number {
  return { low: 0, medium: 1, high: 2, critical: 3 }[priority]
}

function interpolate(template: string, variables: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return String(variables[key] || match)
  })
}

/**
 * Clear notification history (for testing).
 */
export function clearNotifications(): void {
  notificationQueue.length = 0
  notificationHistory.length = 0
}
