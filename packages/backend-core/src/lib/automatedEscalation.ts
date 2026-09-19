// Phase 4.6: Automated escalation and remediation workflows.
// Automatically triggers actions when quotas are exceeded or risks detected.

import { logger } from './logger.js'

export type EscalationAction = 'notify_admin' | 'upgrade_plan' | 'disable_feature' | 'webhook' | 'create_ticket'
export type EscalationTrigger = 'quota_exceeded' | 'cost_spike' | 'repeated_warnings' | 'budget_exceeded'
export type EscalationStatus = 'pending' | 'executing' | 'completed' | 'failed'

export interface EscalationRule {
  id: string
  workspaceId: string
  trigger: EscalationTrigger
  condition: {
    metric?: string
    threshold?: number
    duration?: number // minutes
    consecutive?: number
  }
  actions: EscalationAction[]
  enabled: boolean
  cooldownMinutes?: number // Prevent repeated escalations
  createdAt: Date
  lastTriggeredAt?: Date
}

export interface EscalationEvent {
  id: string
  ruleId: string
  workspaceId: string
  trigger: EscalationTrigger
  status: EscalationStatus
  actionResults: Record<EscalationAction, { success: boolean; message: string }>
  createdAt: Date
  completedAt?: Date
}

// Storage
const escalationRules = new Map<string, EscalationRule[]>()
const escalationEvents: EscalationEvent[] = []
const MAX_EVENTS = 5000

/**
 * Create an escalation rule for a workspace.
 */
export function createEscalationRule(
  workspaceId: string,
  rule: Omit<EscalationRule, 'id' | 'createdAt'>
): EscalationRule {
  const newRule: EscalationRule = {
    ...rule,
    id: `rule-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    createdAt: new Date(),
  }

  const rules = escalationRules.get(workspaceId) || []
  rules.push(newRule)
  escalationRules.set(workspaceId, rules)

  logger.info('escalation rule created', {
    workspaceId,
    trigger: rule.trigger,
    actions: rule.actions.length,
  })

  return newRule
}

/**
 * Get escalation rules for a workspace.
 */
export function getEscalationRules(workspaceId: string, enabled?: boolean): EscalationRule[] {
  const rules = escalationRules.get(workspaceId) || []
  if (enabled !== undefined) {
    return rules.filter((r) => r.enabled === enabled)
  }
  return rules
}

/**
 * Update an escalation rule.
 */
export function updateEscalationRule(workspaceId: string, ruleId: string, updates: Partial<EscalationRule>): boolean {
  const rules = escalationRules.get(workspaceId) || []
  const idx = rules.findIndex((r) => r.id === ruleId)
  if (idx < 0) return false

  Object.assign(rules[idx], updates)
  escalationRules.set(workspaceId, rules)
  return true
}

/**
 * Delete an escalation rule.
 */
export function deleteEscalationRule(workspaceId: string, ruleId: string): boolean {
  const rules = escalationRules.get(workspaceId) || []
  const idx = rules.findIndex((r) => r.id === ruleId)
  if (idx < 0) return false

  rules.splice(idx, 1)
  escalationRules.set(workspaceId, rules)
  return true
}

/**
 * Check if a rule should be triggered.
 */
export function shouldTriggerRule(rule: EscalationRule, context: { metric?: string; value?: number }): boolean {
  // Check enabled
  if (!rule.enabled) return false

  // Check cooldown
  if (rule.lastTriggeredAt) {
    const cooldownMs = ((rule.cooldownMinutes || 60) * 60 * 1000)
    if (Date.now() - rule.lastTriggeredAt.getTime() < cooldownMs) {
      return false // Still in cooldown
    }
  }

  // Check condition
  if (rule.condition.metric && context.metric !== rule.condition.metric) {
    return false
  }

  if (rule.condition.threshold && context.value !== undefined) {
    if (context.value < rule.condition.threshold) {
      return false
    }
  }

  return true
}

/**
 * Trigger an escalation event.
 */
export function triggerEscalation(
  workspaceId: string,
  rule: EscalationRule,
  context: Record<string, unknown>
): EscalationEvent {
  const event: EscalationEvent = {
    id: `event-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    ruleId: rule.id,
    workspaceId,
    trigger: rule.trigger,
    status: 'pending',
    actionResults: {},
    createdAt: new Date(),
  }

  // Execute actions
  for (const action of rule.actions) {
    try {
      const result = executeAction(action, workspaceId, context)
      event.actionResults[action] = result
    } catch (error) {
      event.actionResults[action] = {
        success: false,
        message: String(error),
      }
    }
  }

  // Update rule's last triggered time
  rule.lastTriggeredAt = new Date()

  // Check if all actions succeeded
  const allSucceeded = Object.values(event.actionResults).every((r) => r.success)
  event.status = allSucceeded ? 'completed' : 'failed'
  event.completedAt = new Date()

  // Store event
  escalationEvents.push(event)
  if (escalationEvents.length > MAX_EVENTS) {
    escalationEvents.splice(0, MAX_EVENTS - 2500)
  }

  logger.info('escalation triggered', {
    workspaceId,
    ruleId: rule.id,
    trigger: rule.trigger,
    actions: rule.actions.length,
    succeeded: allSucceeded,
  })

  return event
}

/**
 * Get escalation event history.
 */
export function getEscalationHistory(workspaceId: string, limit: number = 50): EscalationEvent[] {
  return escalationEvents
    .filter((e) => e.workspaceId === workspaceId)
    .slice(-limit)
    .reverse()
}

/**
 * Get escalation statistics.
 */
export function getEscalationStats(workspaceId: string): {
  totalRules: number
  enabledRules: number
  recentTriggersCount: number
  lastTriggerAt?: Date
  successRate: number
} {
  const rules = getEscalationRules(workspaceId)
  const enabledRules = rules.filter((r) => r.enabled)

  // Last 30 days
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000
  const recentEvents = escalationEvents.filter(
    (e) => e.workspaceId === workspaceId && e.createdAt.getTime() > thirtyDaysAgo
  )

  const successfulEvents = recentEvents.filter((e) => e.status === 'completed')
  const successRate = recentEvents.length > 0 ? (successfulEvents.length / recentEvents.length) * 100 : 0

  return {
    totalRules: rules.length,
    enabledRules: enabledRules.length,
    recentTriggersCount: recentEvents.length,
    lastTriggerAt: recentEvents.length > 0 ? recentEvents[recentEvents.length - 1].createdAt : undefined,
    successRate: Math.round(successRate),
  }
}

/**
 * Get recommended escalation rules based on workspace profile.
 */
export function getRecommendedRules(workspaceId: string, plan: 'free' | 'starter' | 'growth'): EscalationRule[] {
  const rules: EscalationRule[] = []

  // All plans: notify on quota exceeded
  rules.push({
    id: 'default-quota-exceeded',
    workspaceId,
    trigger: 'quota_exceeded',
    condition: { threshold: 100 },
    actions: ['notify_admin'],
    enabled: true,
    cooldownMinutes: 60,
    createdAt: new Date(),
  })

  // Free plan: notify on repeated warnings
  if (plan === 'free') {
    rules.push({
      id: 'default-repeated-warnings',
      workspaceId,
      trigger: 'repeated_warnings',
      condition: { consecutive: 3 },
      actions: ['notify_admin'],
      enabled: true,
      cooldownMinutes: 120,
      createdAt: new Date(),
    })
  }

  // Starter+ plans: cost spike and budget exceeded
  if (plan !== 'free') {
    rules.push(
      {
        id: 'default-cost-spike',
        workspaceId,
        trigger: 'cost_spike',
        condition: { threshold: 50 },
        actions: ['notify_admin'],
        enabled: true,
        cooldownMinutes: 180,
        createdAt: new Date(),
      },
      {
        id: 'default-budget-exceeded',
        workspaceId,
        trigger: 'budget_exceeded',
        condition: {},
        actions: ['notify_admin'],
        enabled: true,
        cooldownMinutes: 60,
        createdAt: new Date(),
      }
    )
  }

  // Growth plan: add upgrade action
  if (plan === 'growth') {
    rules.push({
      id: 'default-auto-upgrade',
      workspaceId,
      trigger: 'cost_spike',
      condition: { threshold: 100 },
      actions: ['notify_admin', 'create_ticket'],
      enabled: false, // Disabled by default, opt-in
      cooldownMinutes: 360,
      createdAt: new Date(),
    })
  }

  return rules
}

// Helpers

function executeAction(
  action: EscalationAction,
  workspaceId: string,
  context: Record<string, unknown>
): { success: boolean; message: string } {
  switch (action) {
    case 'notify_admin':
      // In real implementation, would call notificationService
      return {
        success: true,
        message: `Admin notified for workspace ${workspaceId}`,
      }

    case 'upgrade_plan':
      // Would trigger plan upgrade workflow
      return {
        success: true,
        message: `Upgrade workflow initiated for workspace ${workspaceId}`,
      }

    case 'disable_feature':
      // Would disable expensive features
      return {
        success: true,
        message: `Feature access review initiated for workspace ${workspaceId}`,
      }

    case 'webhook':
      // Would call configured webhook
      return {
        success: true,
        message: `Webhook triggered for workspace ${workspaceId}`,
      }

    case 'create_ticket':
      // Would create support ticket
      return {
        success: true,
        message: `Support ticket created for workspace ${workspaceId}`,
      }

    default:
      return {
        success: false,
        message: `Unknown action: ${action}`,
      }
  }
}

/**
 * Clear escalation data (for testing).
 */
export function clearEscalations(): void {
  escalationRules.clear()
  escalationEvents.length = 0
}
