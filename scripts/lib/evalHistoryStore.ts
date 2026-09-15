/**
 * Filesystem I/O for the eval history JSON files, kept separate from the pure
 * scoring/lift math in evalHistory.ts. Each eval script owns one file under
 * eval-results/, committed by the CI workflow so lift is a real, visible
 * number over time rather than living only in ephemeral job logs.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { EvalHistory } from './evalHistory.js'

/** Reads a history file; missing or unparseable → empty history (first run). */
export function readHistoryFile(path: string): EvalHistory {
  if (!existsSync(path)) return []
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(parsed) ? (parsed as EvalHistory) : []
  } catch {
    return []
  }
}

export function writeHistoryFile(path: string, history: EvalHistory): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(history, null, 2) + '\n', 'utf8')
}

/** Appends a line to the GitHub Actions step summary when running in CI; a no-op locally. */
export function appendStepSummary(line: string): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (!summaryPath) return
  try {
    appendFileSync(summaryPath, line + '\n')
  } catch {
    // Best-effort only — never fail the eval run over summary formatting.
  }
}
