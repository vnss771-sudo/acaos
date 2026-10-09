/**
 * Live-eval run metadata: which dataset and model a run used, how long it took
 * and the provider-reported token usage. Tokens come from the provider-call
 * observer (real usage, not estimates); they stay null when the provider
 * reports none. No cost is recorded because prices change and are not known
 * here.
 */
import { readFileSync } from 'node:fs'
import { model, setAiProviderCallObserver } from '@acaos/backend-core/services/openai.js'

export const EVAL_DATASET_VERSION = (JSON.parse(readFileSync(new URL('../../eval/datasets/v1/manifest.json', import.meta.url), 'utf8')) as { version: string }).version

export type EvalRunTelemetry = {
  model: string
  datasetVersion: string
  latencyMs: number
  promptTokens: number | null
  completionTokens: number | null
  totalTokens: number | null
}

/** Starts measuring a live eval run; call the returned function once it ends. */
export function startEvalRun(setObserver: typeof setAiProviderCallObserver = setAiProviderCallObserver): () => EvalRunTelemetry {
  const startedAt = Date.now()
  const totals = { prompt: 0, completion: 0, total: 0, reported: false }
  setObserver((m) => {
    if (m.promptTokens == null && m.completionTokens == null && m.totalTokens == null) return
    totals.reported = true
    totals.prompt += m.promptTokens ?? 0
    totals.completion += m.completionTokens ?? 0
    totals.total += m.totalTokens ?? 0
  })
  return () => {
    setObserver(undefined)
    return {
      model: model(),
      datasetVersion: EVAL_DATASET_VERSION,
      latencyMs: Date.now() - startedAt,
      promptTokens: totals.reported ? totals.prompt : null,
      completionTokens: totals.reported ? totals.completion : null,
      totalTokens: totals.reported ? totals.total : null,
    }
  }
}
