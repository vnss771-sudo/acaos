// Phase 5: Custom automation rules engine with event-driven workflows.
// Enables if-then rules for cost control, notifications, and remediation.

import { logger } from './logger.js'

export type EventType = 'cost_threshold_exceeded' | 'anomaly_detected' | 'budget_degradation' | 'optimization_recommended' | 'forecast_warning' | 'custom'
export type ActionType = 'notify' | 'webhook' | 'auto_optimize' | 'create_ticket' | 'disable_feature' | 'queue_request' | 'custom'
export type ConditionOperator = 'equals' | 'greater_than' | 'less_than' | 'contains' | 'matches_regex'

export interface Condition {
  field: string
  operator: ConditionOperator
  value: unknown
}

export interface Action {
  type: ActionType
  parameters: Record<string, unknown>
}

export interface AutomationRule {
  id: string
  workspaceId: string
  name: string
  description?: string
  enabled: boolean
  trigger: {
    eventType: EventType
    conditions: Condition[]
  }
  actions: Action[]
  priority: number // 1-10, higher = execute first
  createdAt: Date
  updatedAt: Date
}

export interface RuleExecution {
  id: string
  ruleId: string
  workspaceId: string
  triggeredAt: Date
  eventType: EventType
  eventData: Record<string, unknown>
  conditionsMet: boolean
  actionsExecuted: Array<{
    type: ActionType
    success: boolean
    result?: unknown
    error?: string
  }>
}

export interface RuleTemplate {
  id: string
  name: string
  description: string
  trigger: {
    eventType: EventType
    conditions: Condition[]
  }
  actions: Action[]
}

// Storage
const automationRules = new Map<string, AutomationRule[]>()
const ruleExecutions = new Map<string, RuleExecution[]>()
const templates = new Map<string, RuleTemplate>()
const eventSubscribers = new Map<EventType, Array<(data: Record<string, unknown>) => void>>()

/**
 * Create automation rule.
 */
export function createAutomationRule(
  workspaceId: string,
  name: string,
  description: string,
  eventType: EventType,
  conditions: Condition[],
  actions: Action[],
  priority: number = 5
): AutomationRule {
  const rule: AutomationRule = {
    id: `rule-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    workspaceId,
    name,
    description,
    enabled: true,
    trigger: {
      eventType,
      conditions,
    },
    actions,
    priority,
    createdAt: new Date(),
    updatedAt: new Date(),
  }

  const list = automationRules.get(workspaceId) || []
  list.push(rule)
  automationRules.set(workspaceId, list)

  logger.info('automation rule created', {
    workspaceId,
    name,
    eventType,
    conditionCount: conditions.length,
    actionCount: actions.length,
  })

  return rule
}

/**
 * Get automation rules for workspace.
 */
export function getAutomationRules(workspaceId: string, enabled?: boolean): AutomationRule[] {
  const list = automationRules.get(workspaceId) || []
  return enabled !== undefined ? list.filter((r) => r.enabled === enabled) : list
}

/**
 * Update automation rule.
 */
export function updateAutomationRule(
  workspaceId: string,
  ruleId: string,
  updates: Partial<AutomationRule>
): boolean {
  const list = automationRules.get(workspaceId) || []
  const index = list.findIndex((r) => r.id === ruleId)

  if (index < 0) return false

  const rule = list[index]
  Object.assign(rule, { ...updates, updatedAt: new Date() })

  return true
}

/**
 * Disable automation rule.
 */
export function disableAutomationRule(workspaceId: string, ruleId: string): boolean {
  return updateAutomationRule(workspaceId, ruleId, { enabled: false })
}

/**
 * Enable automation rule.
 */
export function enableAutomationRule(workspaceId: string, ruleId: string): boolean {
  return updateAutomationRule(workspaceId, ruleId, { enabled: true })
}

/**
 * Delete automation rule.
 */
export function deleteAutomationRule(workspaceId: string, ruleId: string): boolean {
  const list = automationRules.get(workspaceId) || []
  const filtered = list.filter((r) => r.id !== ruleId)
  automationRules.set(workspaceId, filtered)
  return filtered.length < list.length
}

/**
 * Evaluate condition against event data.
 */
function evaluateCondition(condition: Condition, eventData: Record<string, unknown>): boolean {
  const value = eventData[condition.field]

  switch (condition.operator) {
    case 'equals':
      return value === condition.value
    case 'greater_than':
      return typeof value === 'number' && typeof condition.value === 'number' && value > condition.value
    case 'less_than':
      return typeof value === 'number' && typeof condition.value === 'number' && value < condition.value
    case 'contains':
      return typeof value === 'string' && typeof condition.value === 'string' && value.includes(condition.value)
    case 'matches_regex':
      return typeof value === 'string' && new RegExp(condition.value as string).test(value)
    default:
      return false
  }
}

/**
 * Evaluate all conditions.
 */
function evaluateAllConditions(conditions: Condition[], eventData: Record<string, unknown>): boolean {
  return conditions.length === 0 || conditions.every((c) => evaluateCondition(c, eventData))
}

/**
 * Execute action.
 */
function executeAction(
  action: Action,
  eventData: Record<string, unknown>
): {
  success: boolean
  result?: unknown
  error?: string
} {
  try {
    switch (action.type) {
      case 'notify':
        // In production, integrate with notification service
        logger.info('notification action', action.parameters)
        return { success: true, result: 'Notification sent' }

      case 'webhook':
        // In production, POST to webhook URL
        logger.info('webhook action', action.parameters)
        return { success: true, result: 'Webhook triggered' }

      case 'auto_optimize':
        // In production, trigger optimization engine
        logger.info('auto-optimize action', action.parameters)
        return { success: true, result: 'Optimization triggered' }

      case 'create_ticket':
        // In production, integrate with ticketing system
        logger.info('ticket creation action', action.parameters)
        return { success: true, result: 'Ticket created' }

      case 'disable_feature':
        // In production, call feature access API
        logger.info('feature disable action', action.parameters)
        return { success: true, result: 'Feature disabled' }

      case 'queue_request':
        // In production, call rate limiting API
        logger.info('queue request action', action.parameters)
        return { success: true, result: 'Request queued' }

      case 'custom':
        logger.info('custom action', action.parameters)
        return { success: true, result: 'Custom action executed' }

      default:
        return { success: false, error: 'Unknown action type' }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { success: false, error: message }
  }
}

/**
 * Trigger event and execute matching rules.
 */
export function triggerEvent(
  workspaceId: string,
  eventType: EventType,
  eventData: Record<string, unknown>
): RuleExecution[] {
  const rules = getAutomationRules(workspaceId, true)
    .filter((r) => r.trigger.eventType === eventType)
    .sort((a, b) => b.priority - a.priority)

  const executions: RuleExecution[] = []

  for (const rule of rules) {
    const conditionsMet = evaluateAllConditions(rule.trigger.conditions, eventData)

    if (conditionsMet) {
      const actionsExecuted = rule.actions.map((action) => ({
        type: action.type,
        ...executeAction(action, eventData),
      }))

      const execution: RuleExecution = {
        id: `exec-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        ruleId: rule.id,
        workspaceId,
        triggeredAt: new Date(),
        eventType,
        eventData,
        conditionsMet: true,
        actionsExecuted,
      }

      const execList = ruleExecutions.get(workspaceId) || []
      execList.push(execution)
      ruleExecutions.set(workspaceId, execList)

      executions.push(execution)

      logger.info('rule executed', {
        workspaceId,
        ruleId: rule.id,
        ruleName: rule.name,
        eventType,
        actionsCount: actionsExecuted.length,
      })
    }
  }

  // Notify subscribers
  const subscribers = eventSubscribers.get(eventType) || []
  subscribers.forEach((subscriber) => {
    try {
      subscriber(eventData)
    } catch (error) {
      logger.error('subscriber error', { error })
    }
  })

  return executions
}

/**
 * Get rule execution history.
 */
export function getRuleExecutionHistory(
  workspaceId: string,
  days: number = 30
): RuleExecution[] {
  const list = ruleExecutions.get(workspaceId) || []
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  return list.filter((e) => e.triggeredAt >= cutoff)
}

/**
 * Get execution history for specific rule.
 */
export function getRuleExecutions(
  workspaceId: string,
  ruleId: string,
  limit: number = 50
): RuleExecution[] {
  const list = ruleExecutions.get(workspaceId) || []
  return list.filter((e) => e.ruleId === ruleId).slice(-limit)
}

/**
 * Register event subscriber.
 */
export function subscribeToEvent(
  eventType: EventType,
  handler: (data: Record<string, unknown>) => void
): () => void {
  const subscribers = eventSubscribers.get(eventType) || []
  subscribers.push(handler)
  eventSubscribers.set(eventType, subscribers)

  // Return unsubscribe function
  return () => {
    const list = eventSubscribers.get(eventType) || []
    const index = list.indexOf(handler)
    if (index >= 0) {
      list.splice(index, 1)
    }
  }
}

/**
 * Register rule template.
 */
export function registerRuleTemplate(template: RuleTemplate): void {
  templates.set(template.id, template)

  logger.info('rule template registered', {
    templateId: template.id,
    name: template.name,
    eventType: template.trigger.eventType,
  })
}

/**
 * Get rule template.
 */
export function getRuleTemplate(templateId: string): RuleTemplate | null {
  return templates.get(templateId) || null
}

/**
 * Create rule from template.
 */
export function createRuleFromTemplate(
  workspaceId: string,
  templateId: string,
  name: string,
  overrides?: Partial<AutomationRule>
): AutomationRule | null {
  const template = getRuleTemplate(templateId)
  if (!template) return null

  return createAutomationRule(
    workspaceId,
    name || template.name,
    template.description,
    template.trigger.eventType,
    template.trigger.conditions,
    template.actions,
    overrides?.priority || 5
  )
}

/**
 * Initialize default rule templates.
 */
export function initializeDefaultTemplates(): void {
  registerRuleTemplate({
    id: 'budget_exceeded_alert',
    name: 'Budget Exceeded Alert',
    description: 'Notify on budget threshold exceeded',
    trigger: {
      eventType: 'cost_threshold_exceeded',
      conditions: [
        {
          field: 'percentageUsed',
          operator: 'greater_than',
          value: 90,
        },
      ],
    },
    actions: [
      {
        type: 'notify',
        parameters: { channels: ['#finance-alerts'], severity: 'critical' },
      },
      {
        type: 'create_ticket',
        parameters: { project: 'finance', priority: 'high' },
      },
    ],
  })

  registerRuleTemplate({
    id: 'anomaly_auto_optimize',
    name: 'Anomaly Auto-Optimize',
    description: 'Auto-apply optimizations when anomaly detected',
    trigger: {
      eventType: 'anomaly_detected',
      conditions: [
        {
          field: 'severity',
          operator: 'equals',
          value: 'critical',
        },
      ],
    },
    actions: [
      {
        type: 'auto_optimize',
        parameters: { autoApply: true },
      },
      {
        type: 'webhook',
        parameters: { url: 'https://api.example.com/alert' },
      },
    ],
  })

  registerRuleTemplate({
    id: 'forecast_warning_notify',
    name: 'Forecast Warning Notification',
    description: 'Alert when forecast shows cost increase',
    trigger: {
      eventType: 'forecast_warning',
      conditions: [
        {
          field: 'projectedIncrease',
          operator: 'greater_than',
          value: 20,
        },
      ],
    },
    actions: [
      {
        type: 'notify',
        parameters: { channels: ['#ops', '#management'] },
      },
    ],
  })

  logger.info('default rule templates initialized')
}

/**
 * Clear rules data (for testing).
 */
export function clearRules(): void {
  automationRules.clear()
  ruleExecutions.clear()
  templates.clear()
  eventSubscribers.clear()
}
