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

export type SecuritySeverity = 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL'

type LogParams = {
  eventType: SecurityEventType
  severity?: SecuritySeverity
  userId?: string
  workspaceId?: string
  resourceType?: string
  resourceId?: string
  meta?: Record<string, unknown>
  req?: Request
}

function extractIp(req?: Request): string | undefined {
  if (!req) return undefined
  const fwd = req.headers['x-forwarded-for']
  const ip = Array.isArray(fwd) ? fwd[0] : fwd?.split(',')[0]?.trim()
  return ip || req.socket?.remoteAddress || undefined
}

// Fire-and-forget — never throws, never blocks the request
export function logSecurityEvent(params: LogParams): void {
  const { eventType, severity = 'INFO', userId, workspaceId, resourceType, resourceId, meta, req } = params
  prisma.securityEvent.create({
    data: {
      eventType,
      severity,
      userId: userId ?? null,
      workspaceId: workspaceId ?? null,
      resourceType: resourceType ?? null,
      resourceId: resourceId ?? null,
      ipAddress: extractIp(req) ?? null,
      userAgent: req?.headers['user-agent'] ?? null,
      meta: meta ? (meta as import('@prisma/client').Prisma.InputJsonValue) : undefined,
    }
  }).catch(() => { /* intentionally silent */ })
}
