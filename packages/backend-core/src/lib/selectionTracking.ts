// Selection tracking for campaign send runs — the record needed to reason
// about selection bias later ("did Electrical convert better, or did we only
// contact the easiest Electrical prospects?").
//
// Per run: ordering, fingerprints of the targeting + scoring model in force,
// and final totals (including bulk cut-offs whose leads were never
// enumerated). Per considered lead: SELECTED / EXCLUDED(reason) / FAILED and
// the lead's score at that moment.
//
// Best-effort by design: a failure to record analytics must never block or
// fail a send, so every write is caught and logged, never thrown.

import { createHash } from 'node:crypto'
import { prisma } from './prisma.js'
import { logger } from './logger.js'

export type SelectionDecision = 'SELECTED' | 'EXCLUDED' | 'FAILED'

/** Stable sha256 of a JSON value (key-order independent). */
export function fingerprint(value: unknown): string {
  const canon = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canon)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v as object).sort().map(k => [k, canon((v as Record<string, unknown>)[k])]))
        : v
  return createHash('sha256').update(JSON.stringify(canon(value) ?? null)).digest('hex')
}

type Row = { leadId: string; decision: SelectionDecision; reason: string | null; leadScore: number; outreachSentId: string | null }

export class SelectionRecorder {
  private runId: string | null = null
  private buffer: Row[] = []

  private constructor(private workspaceId: string) {}

  /** Open a run, fingerprinting the ICP targeting and scoring model in force. */
  static async start(workspaceId: string, campaignId: string, orderBy: string): Promise<SelectionRecorder> {
    const rec = new SelectionRecorder(workspaceId)
    try {
      const [icp, model] = await Promise.all([
        prisma.workspaceICP.findUnique({
          where: { workspaceId },
          select: { targetIndustries: true, minEmployees: true, maxEmployees: true, targetGeos: true, excludedIndustries: true, mustHaveEmail: true },
        }),
        prisma.scoringModel.findUnique({ where: { workspaceId }, select: { weights: true, signalWeights: true } }),
      ])
      const run = await prisma.outreachSelectionRun.create({
        data: { workspaceId, campaignId, orderBy, icpFingerprint: fingerprint(icp), modelFingerprint: fingerprint(model) },
        select: { id: true },
      })
      rec.runId = run.id
    } catch (err) {
      logger.error('selection tracking: failed to open run', { workspaceId, campaignId, error: (err as Error).message })
    }
    return rec
  }

  record(lead: { id: string; score: number }, decision: SelectionDecision, reason: string | null = null, outreachSentId: string | null = null): void {
    if (!this.runId) return
    this.buffer.push({ leadId: lead.id, decision, reason, leadScore: Math.round(lead.score ?? 0), outreachSentId })
  }

  async flush(): Promise<void> {
    if (!this.runId || this.buffer.length === 0) return
    const rows = this.buffer
    this.buffer = []
    try {
      await prisma.outreachSelection.createMany({
        data: rows.map(r => ({ ...r, workspaceId: this.workspaceId, runId: this.runId! })),
      })
    } catch (err) {
      logger.error('selection tracking: failed to write decisions', { runId: this.runId, count: rows.length, error: (err as Error).message })
    }
  }

  async finish(totals: Record<string, unknown>): Promise<void> {
    await this.flush()
    if (!this.runId) return
    try {
      await prisma.outreachSelectionRun.update({ where: { id: this.runId }, data: { totals: totals as object, finishedAt: new Date() } })
    } catch (err) {
      logger.error('selection tracking: failed to close run', { runId: this.runId, error: (err as Error).message })
    }
  }
}
