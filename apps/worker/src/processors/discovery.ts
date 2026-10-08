// Pure-DB queue processors, extracted from worker.ts so they can be unit-tested
// against a real database without instantiating BullMQ Workers (which connect to
// Redis on construction). worker.ts wires these into Workers; tests call them
// directly.

import { prisma } from '@acaos/backend-core/lib/prisma.js'
import { getSource, type ProspectCandidate, type ProspectSearchInput } from '@acaos/backend-core/lib/prospectSources.js'
import { importDiscoveredProspects } from '@acaos/backend-core/lib/discoveryImport.js'
import { enqueueScoreProspects } from '@acaos/backend-core/lib/queues.js'
import type { ICPConfig } from '@acaos/backend-core/lib/signalEngine.js'

type Progress = (n: number) => unknown

/** Recompute opportunity scores for every prospect in a workspace. */

export interface DiscoverProspectsResult {
  runId: string
  status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED'
  imported: number
  skipped: number
  total: number
}

export async function discoverProspectsBatch(
  runId: string,
  workspaceId: string,
  progress?: Progress,
  // Injection seam: tests pass a `search` stub so the FAILED/PARTIAL/SUCCEEDED
  // paths can be exercised without a live provider. Defaults to the real source
  // registry resolved from the run's `source`.
  deps: { search?: (input: ProspectSearchInput) => Promise<ProspectCandidate[]> } = {}
): Promise<DiscoverProspectsResult> {
  const run = await prisma.discoveryRun.findUnique({
    where: { id: runId },
    select: { id: true, workspaceId: true, missionId: true, source: true, status: true, query: true },
  })
  // Tenant + state guards: a forged/replayed job can't touch another workspace's
  // run, and a run already finalized (or re-enqueued) is not reprocessed.
  if (!run || run.workspaceId !== workspaceId) {
    return { runId, status: 'FAILED', imported: 0, skipped: 0, total: 0 }
  }
  if (run.status !== 'RUNNING') {
    return { runId, status: run.status as DiscoverProspectsResult['status'], imported: 0, skipped: 0, total: 0 }
  }

  await progress?.(5)

  const query = (run.query ?? {}) as ProspectSearchInput
  const searchFn = deps.search ?? (async (input: ProspectSearchInput) => {
    const source = getSource(run.source)
    if (!source) throw new Error(`Unknown discovery source: ${run.source}`)
    return source.search(input)
  })

  // 1. Provider search — a failure here means nothing was imported: mark FAILED.
  let candidates: ProspectCandidate[]
  try {
    candidates = await searchFn(query)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Discovery provider error'
    const code = (err as { code?: string }).code ?? 'PROVIDER_ERROR'
    await prisma.discoveryRun.update({
      where: { id: run.id },
      data: { status: 'FAILED', errorCode: code, errorMessage: message.slice(0, 500), finishedAt: new Date() },
    }).catch(() => {})
    return { runId, status: 'FAILED', imported: 0, skipped: 0, total: 0 }
  }

  await progress?.(20)

  if (candidates.length === 0) {
    await prisma.discoveryRun.update({
      where: { id: run.id },
      data: { status: 'SUCCEEDED', resultCount: 0, finishedAt: new Date() },
    })
    return { runId, status: 'SUCCEEDED', imported: 0, skipped: 0, total: 0 }
  }

  const icpRecord = await prisma.workspaceICP.findUnique({ where: { workspaceId } })
  const icp: ICPConfig | undefined = icpRecord ? {
    targetIndustries: icpRecord.targetIndustries,
    minEmployees: icpRecord.minEmployees ?? undefined,
    maxEmployees: icpRecord.maxEmployees ?? undefined,
    targetGeos: icpRecord.targetGeos,
    mustHaveEmail: icpRecord.mustHaveEmail,
  } : undefined

  // 2. Import. Track running counts so a fatal mid-batch error (e.g. the DB going
  // away) can be recorded as PARTIAL with what actually landed.
  let imported = 0
  let skipped = 0
  try {
    const result = await importDiscoveredProspects({
      workspaceId,
      missionId: run.missionId,
      sourceName: run.source,
      candidates,
      icp,
      onProgress: (imp, skp) => { imported = imp; skipped = skp },
    })
    imported = result.imported
    skipped = result.skipped
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Discovery import error'
    await prisma.discoveryRun.update({
      where: { id: run.id },
      data: {
        status: 'PARTIAL',
        resultCount: candidates.length,
        importedCount: imported,
        skippedCount: skipped,
        errorCode: 'IMPORT_INTERRUPTED',
        errorMessage: message.slice(0, 500),
        finishedAt: new Date(),
      },
    }).catch(() => {})
    // Best-effort scoring of whatever did land, then surface the failure.
    if (imported > 0) enqueueScoreProspects(workspaceId).catch(() => {})
    return { runId, status: 'PARTIAL', imported, skipped, total: candidates.length }
  }

  await progress?.(90)

  if (imported > 0) enqueueScoreProspects(workspaceId).catch(() => {})

  await prisma.discoveryRun.update({
    where: { id: run.id },
    data: {
      status: 'SUCCEEDED',
      resultCount: candidates.length,
      importedCount: imported,
      skippedCount: skipped,
      finishedAt: new Date(),
    },
  })

  await progress?.(100)
  return { runId, status: 'SUCCEEDED', imported, skipped, total: candidates.length }
}

// ── analyze-reply: apply a parsed reply classification ────────────────────────
// The DB effects of the analyze-reply job, extracted from worker.ts so they can be
// tested against a real database without OpenAI or BullMQ. worker.ts calls the AI,
// parses (fail-closed), then hands the parsed result here. Behavior-preserving.
