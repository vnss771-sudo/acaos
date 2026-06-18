import { prisma } from './prisma.js'
import { Prisma } from '@prisma/client'

export type AuditInput = {
  workspaceId?: string | null
  actorUserId?: string | null
  type: string
  entityType?: string
  entityId?: string
  metadata?: Record<string, unknown>
}

// Best-effort audit recording. Never throws — an audit failure must not break the
// action it is recording. Fire-and-forget at call sites (no await needed).
export async function recordAudit(e: AuditInput): Promise<void> {
  try {
    await prisma.auditEvent.create({
      data: {
        workspaceId: e.workspaceId ?? null,
        actorUserId: e.actorUserId ?? null,
        type: e.type,
        entityType: e.entityType ?? null,
        entityId: e.entityId ?? null,
        metadata: (e.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    })
  } catch (err) {
    console.warn('[audit] failed to record event:', (err as Error).message)
  }
}
