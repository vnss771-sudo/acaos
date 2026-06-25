import { prisma } from './prisma.js'
import type { Prisma } from '@prisma/client'
import { logger } from './logger.js'
import { captureError } from './observability.js'

export type AuditInput = {
  workspaceId?: string | null
  actorUserId?: string | null
  type: string
  entityType?: string
  entityId?: string
  metadata?: Record<string, unknown>
}

function auditCreateData(e: AuditInput) {
  return {
    workspaceId: e.workspaceId ?? null,
    actorUserId: e.actorUserId ?? null,
    type: e.type,
    entityType: e.entityType ?? null,
    entityId: e.entityId ?? null,
    metadata: (e.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
  }
}

// Best-effort audit recording for routine events. Never throws — an audit failure
// must not break the action it is recording. Fire-and-forget at call sites.
export async function recordAudit(e: AuditInput): Promise<void> {
  try {
    await prisma.auditEvent.create({ data: auditCreateData(e) })
  } catch (err) {
    logger.warn('audit event failed to record', { type: e.type, error: (err as Error).message })
  }
}

// Security-critical audit recording (admin bootstrap, refresh-token reuse, workspace
// erasure, MFA disable/lockout, …). Same write, but a failure is NOT silently
// swallowed: it is escalated to the error reporter (pages on-call) and logged at
// error level, so SOC2 logging-completeness gaps become visible instead of invisible.
//
// It still does not THROW: failing the underlying security action (e.g. a workspace
// erasure) because the audit row couldn't be written would be worse than completing
// the action with a loud, alerting record of the audit failure. Callers should
// `await` it so the write is on the critical path (any failure is observed before the
// response is sent), not fire-and-forget.
export async function recordCriticalAudit(e: AuditInput): Promise<void> {
  try {
    await prisma.auditEvent.create({ data: auditCreateData(e) })
  } catch (err) {
    logger.error('CRITICAL audit event failed to record', { type: e.type, entityId: e.entityId, error: (err as Error).message })
    captureError(err, { kind: 'critical-audit-failure', auditType: e.type, entityType: e.entityType, entityId: e.entityId })
  }
}
