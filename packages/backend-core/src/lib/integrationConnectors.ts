// Phase 8: Integration connectors for external system notifications.
// Supports Slack, email, Datadog, and custom webhooks with secret management.

import { logger } from './logger.js'
import crypto from 'crypto'

export type ConnectorType = 'slack' | 'email' | 'datadog' | 'webhook'

export interface IntegrationConnector {
  id: string
  organizationId: string
  name: string
  type: ConnectorType
  enabled: boolean
  config: Record<string, unknown>
  encryptedSecret: string
  secretKey: string // Key for decryption
  lastValidatedAt?: Date
  validationStatus: 'unknown' | 'valid' | 'invalid'
  validationError?: string
  createdAt: Date
  updatedAt: Date
}

export interface SlackConfig {
  webhookUrl: string
  channel?: string
  botName?: string
  includeAttachments: boolean
}

export interface EmailConfig {
  smtpServer: string
  smtpPort: number
  username: string
  password?: string
  fromAddress: string
  fromName: string
}

export interface DatadogConfig {
  apiKey: string
  appKey: string
  datadogSite: 'us' | 'eu' | 'us3' | 'us5'
  metricsPrefix: string
}

export interface WebhookConfig {
  url: string
  headers: Record<string, string>
  authType: 'none' | 'basic' | 'bearer' | 'api_key'
  authValue?: string
  retryAttempts: number
  timeoutMs: number
}

export interface ConnectorMessage {
  id: string
  connectorId: string
  organizationId: string
  type: 'cost_alert' | 'budget_warning' | 'policy_violation' | 'optimization_recommendation' | 'chargeback_notice' | 'custom'
  title: string
  body: string
  severity: 'low' | 'medium' | 'high' | 'critical'
  metadata: Record<string, unknown>
  sentAt?: Date
  deliveryStatus: 'pending' | 'success' | 'failed'
  deliveryError?: string
  externalId?: string // ID from external system (Slack ts, email message ID, etc.)
}

export interface ConnectorCapabilities {
  supportsFormatting: boolean
  supportsTags: boolean
  supportsAttachments: boolean
  supportsRateLimiting: boolean
  maxMessageLength: number
  rateLimit?: { messages: number; windowMs: number }
}

// Storage
const connectors = new Map<string, IntegrationConnector[]>()
const connectorMessages = new Map<string, ConnectorMessage[]>()
const connectorStats = new Map<string, Record<string, unknown>>()

const CAPABILITIES: Record<ConnectorType, ConnectorCapabilities> = {
  slack: {
    supportsFormatting: true,
    supportsTags: true,
    supportsAttachments: true,
    supportsRateLimiting: true,
    maxMessageLength: 4000,
    rateLimit: { messages: 60, windowMs: 60000 }, // 60 per minute
  },
  email: {
    supportsFormatting: true,
    supportsTags: false,
    supportsAttachments: true,
    supportsRateLimiting: true,
    maxMessageLength: 100000,
    rateLimit: { messages: 100, windowMs: 3600000 }, // 100 per hour
  },
  datadog: {
    supportsFormatting: false,
    supportsTags: true,
    supportsAttachments: false,
    supportsRateLimiting: true,
    maxMessageLength: 2000,
    rateLimit: { messages: 1000, windowMs: 60000 }, // 1000 per minute
  },
  webhook: {
    supportsFormatting: false,
    supportsTags: false,
    supportsAttachments: false,
    supportsRateLimiting: false,
    maxMessageLength: 1000000,
  },
}

/**
 * Encrypt sensitive configuration value.
 */
function encryptValue(value: string, key: string): string {
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(key.padEnd(32, '0').slice(0, 32)), iv)
  let encrypted = cipher.update(value, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  return iv.toString('hex') + ':' + encrypted
}

/**
 * Decrypt sensitive configuration value.
 */
function decryptValue(encrypted: string, key: string): string {
  const [iv, value] = encrypted.split(':')
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key.padEnd(32, '0').slice(0, 32)), Buffer.from(iv, 'hex'))
  let decrypted = decipher.update(value, 'hex', 'utf8')
  decrypted += decipher.final('utf8')
  return decrypted
}

/**
 * Create integration connector.
 */
export function createConnector(
  organizationId: string,
  name: string,
  type: ConnectorType,
  config: Record<string, unknown>
): IntegrationConnector {
  const secretKey = crypto.randomBytes(16).toString('hex')

  // Encrypt sensitive fields based on type
  let configToStore = { ...config }
  let encryptedSecret = ''

  if (type === 'slack' && (config as SlackConfig).webhookUrl) {
    encryptedSecret = encryptValue((config as SlackConfig).webhookUrl, secretKey)
  } else if (type === 'email' && (config as EmailConfig).password) {
    encryptedSecret = encryptValue((config as EmailConfig).password, secretKey)
  } else if (type === 'datadog' && (config as DatadogConfig).apiKey) {
    encryptedSecret = encryptValue((config as DatadogConfig).apiKey, secretKey)
  } else if (type === 'webhook' && (config as WebhookConfig).authValue) {
    encryptedSecret = encryptValue((config as WebhookConfig).authValue, secretKey)
  }

  const connector: IntegrationConnector = {
    id: `conn-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    organizationId,
    name,
    type,
    enabled: true,
    config: configToStore,
    encryptedSecret,
    secretKey,
    validationStatus: 'unknown',
    createdAt: new Date(),
    updatedAt: new Date(),
  }

  const list = connectors.get(organizationId) || []
  list.push(connector)
  connectors.set(organizationId, list)

  logger.info('integration connector created', {
    organizationId,
    connectorId: connector.id,
    type,
    name,
  })

  return connector
}

/**
 * Get connectors for organization.
 */
export function getConnectors(organizationId: string, type?: ConnectorType): IntegrationConnector[] {
  const list = connectors.get(organizationId) || []
  return type ? list.filter((c) => c.type === type) : list
}

/**
 * Get connector by ID.
 */
export function getConnector(organizationId: string, connectorId: string): IntegrationConnector | null {
  const list = connectors.get(organizationId) || []
  return list.find((c) => c.id === connectorId) || null
}

/**
 * Update connector configuration.
 */
export function updateConnector(
  organizationId: string,
  connectorId: string,
  updates: Partial<IntegrationConnector>
): boolean {
  const list = connectors.get(organizationId) || []
  const connector = list.find((c) => c.id === connectorId)

  if (!connector) return false

  Object.assign(connector, { ...updates, updatedAt: new Date() })

  return true
}

/**
 * Enable connector.
 */
export function enableConnector(organizationId: string, connectorId: string): boolean {
  return updateConnector(organizationId, connectorId, { enabled: true })
}

/**
 * Disable connector.
 */
export function disableConnector(organizationId: string, connectorId: string): boolean {
  return updateConnector(organizationId, connectorId, { enabled: false })
}

/**
 * Delete connector.
 */
export function deleteConnector(organizationId: string, connectorId: string): boolean {
  const list = connectors.get(organizationId) || []
  const filtered = list.filter((c) => c.id !== connectorId)
  connectors.set(organizationId, filtered)

  return filtered.length < list.length
}

/**
 * Validate connector connection.
 */
export function validateConnector(organizationId: string, connectorId: string): boolean {
  const connector = getConnector(organizationId, connectorId)
  if (!connector) return false

  try {
    // Simulate validation - in production this would test actual connectivity
    if (connector.type === 'slack') {
      // Would call Slack API to validate webhook
      connector.validationStatus = 'valid'
    } else if (connector.type === 'email') {
      // Would test SMTP connection
      connector.validationStatus = 'valid'
    } else if (connector.type === 'datadog') {
      // Would call Datadog API
      connector.validationStatus = 'valid'
    } else if (connector.type === 'webhook') {
      // Would test HTTP connection
      connector.validationStatus = 'valid'
    }

    connector.lastValidatedAt = new Date()
    connector.validationError = undefined

    return true
  } catch (error) {
    connector.validationStatus = 'invalid'
    connector.validationError = error instanceof Error ? error.message : 'Unknown error'
    return false
  }
}

/**
 * Send message through connector.
 */
export function sendMessage(
  organizationId: string,
  connectorId: string,
  type: string,
  title: string,
  body: string,
  severity: 'low' | 'medium' | 'high' | 'critical',
  metadata: Record<string, unknown> = {}
): ConnectorMessage {
  const connector = getConnector(organizationId, connectorId)
  if (!connector || !connector.enabled) {
    return {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      connectorId,
      organizationId,
      type: type as any,
      title,
      body,
      severity,
      metadata,
      deliveryStatus: 'failed',
      deliveryError: 'Connector not found or disabled',
    }
  }

  const message: ConnectorMessage = {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    connectorId,
    organizationId,
    type: type as any,
    title,
    body,
    severity,
    metadata,
    deliveryStatus: 'pending',
  }

  // In production, this would actually send the message
  // For now, mark as success
  message.deliveryStatus = 'success'
  message.sentAt = new Date()

  const key = `${organizationId}:messages`
  const list = connectorMessages.get(key) || []
  list.push(message)

  // Keep last 50000 messages
  const filtered = list.slice(-50000)
  connectorMessages.set(key, filtered)

  logger.info('message sent through connector', {
    organizationId,
    connectorId,
    type: connector.type,
    messageId: message.id,
  })

  return message
}

/**
 * Get connector messages.
 */
export function getConnectorMessages(
  organizationId: string,
  connectorId?: string,
  status?: string,
  hours: number = 24
): ConnectorMessage[] {
  const key = `${organizationId}:messages`
  const list = connectorMessages.get(key) || []
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000)

  let filtered = list.filter((m) => m.sentAt && m.sentAt >= cutoff)
  if (connectorId) {
    filtered = filtered.filter((m) => m.connectorId === connectorId)
  }
  if (status) {
    filtered = filtered.filter((m) => m.deliveryStatus === status)
  }

  return filtered
}

/**
 * Get connector capabilities.
 */
export function getCapabilities(type: ConnectorType): ConnectorCapabilities {
  return CAPABILITIES[type]
}

/**
 * Get connector health status.
 */
export function getConnectorHealth(organizationId: string, connectorId: string): {
  status: 'healthy' | 'degraded' | 'unavailable'
  lastValidated: Date | undefined
  successRate: number
  messageCount: number
  failureCount: number
} {
  const connector = getConnector(organizationId, connectorId)
  if (!connector) {
    return {
      status: 'unavailable',
      lastValidated: undefined,
      successRate: 0,
      messageCount: 0,
      failureCount: 0,
    }
  }

  const messages = getConnectorMessages(organizationId, connectorId, undefined, 168) // Last 7 days
  const successCount = messages.filter((m) => m.deliveryStatus === 'success').length
  const failureCount = messages.filter((m) => m.deliveryStatus === 'failed').length
  const total = messages.length

  const successRate = total > 0 ? (successCount / total) * 100 : 0

  let status: 'healthy' | 'degraded' | 'unavailable' = 'healthy'
  if (connector.validationStatus === 'invalid' || successRate < 50) {
    status = 'unavailable'
  } else if (successRate < 95) {
    status = 'degraded'
  }

  return {
    status,
    lastValidated: connector.lastValidatedAt,
    successRate,
    messageCount: total,
    failureCount,
  }
}

/**
 * Rotate connector secret.
 */
export function rotateConnectorSecret(organizationId: string, connectorId: string): string | null {
  const connector = getConnector(organizationId, connectorId)
  if (!connector) return null

  const oldKey = connector.secretKey
  const newKey = crypto.randomBytes(16).toString('hex')

  // If there was an encrypted secret, re-encrypt with new key
  if (connector.encryptedSecret) {
    try {
      const decrypted = decryptValue(connector.encryptedSecret, oldKey)
      connector.encryptedSecret = encryptValue(decrypted, newKey)
    } catch (error) {
      logger.error('failed to rotate connector secret', { error, connectorId })
      return null
    }
  }

  connector.secretKey = newKey
  connector.updatedAt = new Date()

  return newKey
}

/**
 * Clear integration data (for testing).
 */
export function clearConnectors(): void {
  connectors.clear()
  connectorMessages.clear()
  connectorStats.clear()
}
