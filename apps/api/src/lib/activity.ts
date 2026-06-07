import { prisma } from './prisma.js'

export type ActivityType =
  | 'CREATED'
  | 'STAGE_CHANGE'
  | 'SCORE_UPDATE'
  | 'AI_RESEARCH'
  | 'AI_OUTREACH'
  | 'AI_REPLY'
  | 'NOTE'
  | 'IMPORTED'
  | 'FIELD_UPDATE'

export async function logActivity(params: {
  leadId: string
  workspaceId: string
  userId?: string | null
  type: ActivityType
  meta?: Record<string, unknown>
}): Promise<void> {
  try {
    await prisma.leadActivity.create({
      data: {
        leadId: params.leadId,
        workspaceId: params.workspaceId,
        userId: params.userId ?? null,
        type: params.type,
        meta: params.meta ?? null
      }
    })
  } catch {
    // Activity logging is non-critical — never let it crash a request
  }
}

export async function logBatch(
  entries: Array<{
    leadId: string
    workspaceId: string
    userId?: string | null
    type: ActivityType
    meta?: Record<string, unknown>
  }>
): Promise<void> {
  if (entries.length === 0) return
  try {
    await prisma.leadActivity.createMany({
      data: entries.map(e => ({
        leadId: e.leadId,
        workspaceId: e.workspaceId,
        userId: e.userId ?? null,
        type: e.type,
        meta: e.meta ?? null
      }))
    })
  } catch {
    // Non-critical
  }
}
