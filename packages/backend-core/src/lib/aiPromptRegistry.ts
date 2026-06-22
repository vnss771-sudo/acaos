import { prisma } from './prisma.js'
import type { Prisma } from '@prisma/client'

// AI generation provenance. Every AI-generated artifact (an outreach draft today)
// should be traceable to the model + prompt version + sampling params that produced
// it — for auditability, reproducibility, and the ability to correlate quality or
// reply rates to a specific prompt/model. The AiPromptVersion table is the registry;
// this resolves (find-or-create) the row for the current generator config and
// returns its id to stamp on the draft.
//
// Best-effort by contract: provenance must NEVER block or fail a generation. Every
// path swallows errors and returns null so a registry hiccup is invisible to the
// send/generate flow.

export interface PromptVersionInput {
  workspaceId: string
  type: string // 'OUTREACH' | 'REPLY_ANALYSIS' | 'SCORING' | 'RECOMMENDATIONS'
  model: string
  promptHash: string
  maxTokens?: number | null
  temperature?: number | null
  metadata?: Record<string, unknown>
}

/**
 * Find-or-create the AiPromptVersion for a generator config, returning its id (or
 * null on any failure — provenance is non-critical). An unchanged config (same
 * promptHash) reuses its row; a changed config creates the next version for that
 * (workspace, type). Races are tolerated: a unique-violation on the version number
 * is resolved by re-reading the row that won.
 */
export async function resolvePromptVersionId(input: PromptVersionInput): Promise<string | null> {
  const { workspaceId, type, promptHash } = input
  try {
    const existing = await prisma.aiPromptVersion.findFirst({
      where: { workspaceId, type, promptHash },
      select: { id: true },
    })
    if (existing) return existing.id

    // First time we've seen this config for the workspace+type → next version.
    const latest = await prisma.aiPromptVersion.findFirst({
      where: { workspaceId, type },
      orderBy: { version: 'desc' },
      select: { version: true },
    })
    const version = (latest?.version ?? 0) + 1

    try {
      const created = await prisma.aiPromptVersion.create({
        data: {
          workspaceId,
          type,
          version,
          promptHash,
          model: input.model,
          maxTokens: input.maxTokens ?? null,
          temperature: input.temperature ?? null,
          isActive: true,
          ...(input.metadata ? { metadata: input.metadata as Prisma.InputJsonValue } : {}),
        },
        select: { id: true },
      })
      return created.id
    } catch (err) {
      // A concurrent generation created the same (workspace,type,version) or
      // (workspace,type,promptHash) first — re-read the winner by hash.
      if ((err as { code?: string }).code === 'P2002') {
        const won = await prisma.aiPromptVersion.findFirst({
          where: { workspaceId, type, promptHash },
          select: { id: true },
        })
        return won?.id ?? null
      }
      throw err
    }
  } catch {
    return null // never let provenance failures affect generation
  }
}
