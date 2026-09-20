// Phase 4.6: Notifications and escalation management endpoints
// Manages notification preferences, delivery, and automated escalation rules.

import { Router } from 'express'
import { asyncHandler } from '../../lib/http.js'
import {
  setNotificationPreference,
  getNotificationPreferences,
  queueNotification,
  getNotificationHistory,
  getNotificationStats,
  setQuietMode,
  testNotification,
  type NotificationChannel,
} from '@acaos/backend-core/lib/notificationService.js'
import {
  createEscalationRule,
  getEscalationRules,
  updateEscalationRule,
  deleteEscalationRule,
  getEscalationHistory,
  getEscalationStats,
  getRecommendedRules,
  triggerEscalation,
} from '@acaos/backend-core/lib/automatedEscalation.js'

export const phase46NotificationsRouter = Router()

// ============================================================================
// Notification Preference Endpoints
// ============================================================================

/**
 * GET /api/ops/notifications/preferences/:workspaceId — Get notification settings.
 */
phase46NotificationsRouter.get(
  '/preferences/:workspaceId',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params

    const prefs = getNotificationPreferences(workspaceId)

    res.json({
      workspaceId,
      preferences: prefs.map((p) => ({
        channel: p.channel,
        enabled: p.enabled,
        destination: p.destination,
        minPriority: p.minPriority,
        quietHours: p.quietHours,
        batchDaily: p.batchDaily,
      })),
      summary: {
        total: prefs.length,
        enabled: prefs.filter((p) => p.enabled).length,
        channels: [...new Set(prefs.map((p) => p.channel))],
      },
    })
  })
)

/**
 * PUT /api/ops/notifications/preferences/:workspaceId/:channel — Configure notification channel.
 */
phase46NotificationsRouter.put(
  '/preferences/:workspaceId/:channel',
  asyncHandler(async (req, res) => {
    const { workspaceId, channel } = req.params
    const { enabled, destination, minPriority, quietHours, batchDaily } = req.body

    const pref = setNotificationPreference(workspaceId, {
      channel: channel as NotificationChannel,
      enabled: enabled ?? true,
      destination,
      minPriority,
      quietHours,
      batchDaily: batchDaily ?? false,
    })

    res.json({
      success: true,
      preference: {
        channel: pref.channel,
        enabled: pref.enabled,
        destination: pref.destination,
      },
      message: `${channel} notifications configured for workspace`,
    })
  })
)

/**
 * POST /api/ops/notifications/test/:workspaceId/:channel — Test notification delivery.
 */
phase46NotificationsRouter.post(
  '/test/:workspaceId/:channel',
  asyncHandler(async (req, res) => {
    const { workspaceId, channel } = req.params

    const result = testNotification(workspaceId, channel as NotificationChannel)

    res.json({
      workspaceId,
      channel,
      ...result,
    })
  })
)

/**
 * POST /api/ops/notifications/quiet-mode/:workspaceId — Temporarily disable notifications.
 */
phase46NotificationsRouter.post(
  '/quiet-mode/:workspaceId',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params
    const { enabled, until } = req.body

    setQuietMode(workspaceId, enabled, until ? new Date(until) : undefined)

    res.json({
      workspaceId,
      quietMode: enabled,
      until: until || null,
      message: enabled ? 'Notifications paused' : 'Notifications resumed',
    })
  })
)

/**
 * GET /api/ops/notifications/history/:workspaceId — Notification delivery history.
 */
phase46NotificationsRouter.get(
  '/history/:workspaceId',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params
    const limit = parseInt(req.query.limit as string) || 50

    const history = getNotificationHistory(workspaceId, limit)

    res.json({
      workspaceId,
      count: history.length,
      notifications: history.map((n) => ({
        id: n.id,
        type: n.type,
        priority: n.priority,
        subject: n.subject,
        channels: n.channels,
        status: n.status,
        attempts: n.attempts,
        createdAt: n.createdAt.toISOString(),
        deliveredAt: n.status === 'delivered' ? n.lastAttemptAt?.toISOString() : null,
      })),
    })
  })
)

/**
 * GET /api/ops/notifications/stats — System-wide notification statistics.
 */
phase46NotificationsRouter.get(
  '/stats',
  asyncHandler(async (_req, res) => {
    const stats = getNotificationStats()

    res.json({
      summary: stats,
      status:
        stats.failed > 0
          ? 'degraded'
          : stats.pending > 10
            ? 'warning'
            : 'healthy',
      recommendations: [
        stats.pending > 100 ? 'High queue depth — check delivery service' : '',
        stats.failed > 10 ? 'Multiple delivery failures detected' : '',
        stats.totalDelivered === 0 ? 'No notifications delivered yet' : '',
      ].filter(Boolean),
    })
  })
)

// ============================================================================
// Escalation Rule Endpoints
// ============================================================================

/**
 * GET /api/ops/escalations/rules/:workspaceId — Get escalation rules.
 */
phase46NotificationsRouter.get(
  '/escalations/rules/:workspaceId',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params
    const enabled = req.query.enabled ? req.query.enabled === 'true' : undefined

    const rules = getEscalationRules(workspaceId, enabled)

    res.json({
      workspaceId,
      rules: rules.map((r) => ({
        id: r.id,
        trigger: r.trigger,
        condition: r.condition,
        actions: r.actions,
        enabled: r.enabled,
        cooldownMinutes: r.cooldownMinutes,
        lastTriggeredAt: r.lastTriggeredAt?.toISOString(),
      })),
      summary: {
        total: rules.length,
        enabled: rules.filter((r) => r.enabled).length,
      },
    })
  })
)

/**
 * POST /api/ops/escalations/rules/:workspaceId — Create escalation rule.
 */
phase46NotificationsRouter.post(
  '/escalations/rules/:workspaceId',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params
    const { trigger, condition, actions, enabled, cooldownMinutes } = req.body

    // @ts-ignore - type mismatch handled at runtime
    const rule = createEscalationRule(workspaceId, {
      trigger,
      condition: condition || {},
      actions,
      enabled: enabled ?? true,
      cooldownMinutes: cooldownMinutes ?? 60,
    })

    res.json({
      success: true,
      rule: {
        id: rule.id,
        trigger: rule.trigger,
        actions: rule.actions,
        enabled: rule.enabled,
      },
      message: 'Escalation rule created',
    })
  })
)

/**
 * PUT /api/ops/escalations/rules/:workspaceId/:ruleId — Update escalation rule.
 */
phase46NotificationsRouter.put(
  '/escalations/rules/:workspaceId/:ruleId',
  asyncHandler(async (req, res) => {
    const { workspaceId, ruleId } = req.params
    const { enabled, condition, actions, cooldownMinutes } = req.body

    const success = updateEscalationRule(workspaceId, ruleId, {
      enabled,
      condition: condition ?? undefined,
      actions: actions ?? undefined,
      cooldownMinutes: cooldownMinutes ?? undefined,
    })

    if (!success) {
      return res.status(404).json({ error: 'Rule not found' })
    }

    res.json({
      success: true,
      message: 'Escalation rule updated',
    })
  })
)

/**
 * DELETE /api/ops/escalations/rules/:workspaceId/:ruleId — Delete escalation rule.
 */
phase46NotificationsRouter.delete(
  '/escalations/rules/:workspaceId/:ruleId',
  asyncHandler(async (req, res) => {
    const { workspaceId, ruleId } = req.params

    const success = deleteEscalationRule(workspaceId, ruleId)

    if (!success) {
      return res.status(404).json({ error: 'Rule not found' })
    }

    res.json({
      success: true,
      message: 'Escalation rule deleted',
    })
  })
)

/**
 * GET /api/ops/escalations/recommended/:workspaceId/:plan — Recommended rules.
 */
phase46NotificationsRouter.get(
  '/escalations/recommended/:workspaceId/:plan',
  asyncHandler(async (req, res) => {
    const { workspaceId, plan } = req.params

    const recommended = getRecommendedRules(workspaceId, plan as 'free' | 'starter' | 'growth')

    res.json({
      workspaceId,
      plan,
      recommended: recommended.map((r) => ({
        id: r.id,
        trigger: r.trigger,
        actions: r.actions,
        description: `Automatically ${r.actions.join(' and ')} on ${r.trigger}`,
      })),
      message: 'Apply recommended rules to enable automatic escalation',
    })
  })
)

/**
 * GET /api/ops/escalations/history/:workspaceId — Escalation event history.
 */
phase46NotificationsRouter.get(
  '/escalations/history/:workspaceId',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params
    const limit = parseInt(req.query.limit as string) || 50

    const history = getEscalationHistory(workspaceId, limit)

    res.json({
      workspaceId,
      count: history.length,
      events: history.map((e) => ({
        id: e.id,
        trigger: e.trigger,
        status: e.status,
        actions: Object.keys(e.actionResults),
        results: e.actionResults,
        createdAt: e.createdAt.toISOString(),
        completedAt: e.completedAt?.toISOString(),
      })),
    })
  })
)

/**
 * GET /api/ops/escalations/stats/:workspaceId — Escalation statistics.
 */
phase46NotificationsRouter.get(
  '/escalations/stats/:workspaceId',
  asyncHandler(async (req, res) => {
    const { workspaceId } = req.params

    const stats = getEscalationStats(workspaceId)

    res.json({
      workspaceId,
      rules: {
        total: stats.totalRules,
        enabled: stats.enabledRules,
      },
      recent: {
        triggersCount: stats.recentTriggersCount,
        lastTrigger: stats.lastTriggerAt?.toISOString(),
        successRate: stats.successRate + '%',
      },
      recommendation:
        stats.enabledRules === 0
          ? 'No escalation rules enabled. Use /recommended endpoint to set up automatic escalation.'
          : stats.successRate < 80
            ? 'Some escalation actions are failing. Review action configuration.'
            : 'Escalation system healthy',
    })
  })
)

/**
 * POST /api/ops/escalations/test/:workspaceId/:ruleId — Test escalation rule.
 */
phase46NotificationsRouter.post(
  '/escalations/test/:workspaceId/:ruleId',
  asyncHandler(async (req, res) => {
    const { workspaceId, ruleId } = req.params

    const rules = getEscalationRules(workspaceId)
    const rule = rules.find((r) => r.id === ruleId)

    if (!rule) {
      return res.status(404).json({ error: 'Rule not found' })
    }

    const event = triggerEscalation(workspaceId, rule, { test: true })

    res.json({
      success: event.status === 'completed',
      event: {
        id: event.id,
        trigger: event.trigger,
        status: event.status,
        actions: Object.entries(event.actionResults).map(([action, result]) => ({
          action,
          success: result.success,
          message: result.message,
        })),
      },
    })
  })
)
