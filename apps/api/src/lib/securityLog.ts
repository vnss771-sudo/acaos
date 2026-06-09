// Security audit trail — fire-and-forget, never blocks requests
import { prisma } from './prisma.js'
import type { Request } from 'express'

export type SecurityEventType =
  | 'AUTH_SIGNUP'
  | 'AUTH_LOGIN_SUCCESS'
  | 'AUTH_LOGIN_FAILURE'
  | 'AUTH_LOGOUT'
  | 'AUTH_TOKEN_REFRESH'
  | 'AUTH_TOKEN_INVALID'
  | 'ACCESS_DENIED'
  | 'PROSPECT_DELETED'
  | 'SIGNAL_CREATED'
  | 'ICP_UPDATED'
  | 'SCORE_CALIBRATED'
  | 'WORKSPACE_CREATED'

export type SecuritySeverity = 'INFO' | 'WARN' | 'ERROR'

type LogParams = {
  eventType:    SecurityEventType
  severity?:    SecuritySeverity
  userId?:      string
  workspaceId?: string
  req?:         Request
  resourceType?: string
  resourceId?:   string
  meta?:         Record<string, unknown>
}

function extractIp(req?: Request): string | undefined {
  if (!req) return undefined
  const forwarded = req.headers['x-forwarded-for']
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0]?.trim()
  return raw || req.socket?.remoteAddress
}

export function logSecurityEvent(params: LogParams): void {
  const { eventType, severity = 'INFO', userId, workspaceId, req, resourceType, resourceId, meta } = params
  // Intentionally fire-and-forget — never awaited, never throws
  prisma.securityEvent.create({
    data: {
      eventType,
      severity,
      userId:       userId ?? null,
      workspaceId:  workspaceId ?? null,
      ipAddress:    extractIp(req) ?? null,
      userAgent:    req?.headers['user-agent'] ?? null,
      resourceType: resourceType ?? null,
      resourceId:   resourceId ?? null,
      meta:         meta ? (meta as object) : undefined,
    },
  }).catch(() => { /* swallow — never let logging break request handling */ })
}
