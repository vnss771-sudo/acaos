// Unit tests for scripts/lib/evalHistoryStore.ts — the filesystem I/O side of
// eval-run history (kept separate from the pure scoring/lift math in
// evalHistory.ts, already covered by tests/eval-history.test.ts). Previously
// untested in the unit tier at all: eval-outreach.ts/eval-research.ts are the
// only callers, and neither runs under `npm test` (they need OPENAI_API_KEY).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readHistoryFile, writeHistoryFile, appendStepSummary } from '../scripts/lib/evalHistoryStore.ts'

test('readHistoryFile: returns an empty array when the file does not exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acaos-eval-history-'))
  try {
    assert.deepEqual(readHistoryFile(join(dir, 'missing.json')), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readHistoryFile: returns an empty array for unparseable JSON (a first-run-safe default, not a crash)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acaos-eval-history-'))
  try {
    const path = join(dir, 'history.json')
    writeFileSync(path, 'not valid json{', 'utf8')
    assert.deepEqual(readHistoryFile(path), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readHistoryFile: returns an empty array when the file contains valid JSON that is not an array', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acaos-eval-history-'))
  try {
    const path = join(dir, 'history.json')
    writeFileSync(path, JSON.stringify({ not: 'an array' }), 'utf8')
    assert.deepEqual(readHistoryFile(path), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readHistoryFile: round-trips what writeHistoryFile wrote', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acaos-eval-history-'))
  try {
    const path = join(dir, 'nested', 'history.json')
    const history = [{ date: '2026-01-01', score: 92 }, { date: '2026-01-02', score: 95 }]
    writeHistoryFile(path, history as never)
    assert.deepEqual(readHistoryFile(path), history)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writeHistoryFile: creates parent directories that do not exist yet', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acaos-eval-history-'))
  try {
    const path = join(dir, 'a', 'b', 'c', 'history.json')
    writeHistoryFile(path, [] as never)
    assert.equal(existsSync(path), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writeHistoryFile: writes pretty-printed JSON ending in a trailing newline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acaos-eval-history-'))
  try {
    const path = join(dir, 'history.json')
    writeHistoryFile(path, [{ date: '2026-01-01', score: 92 }] as never)
    const raw = readFileSync(path, 'utf8')
    assert.ok(raw.endsWith('\n'), 'ends with a trailing newline')
    assert.ok(raw.includes('\n  '), 'pretty-printed (indented), not a single-line JSON blob')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('appendStepSummary: a no-op when GITHUB_STEP_SUMMARY is unset (local run, not CI)', () => {
  const prior = process.env.GITHUB_STEP_SUMMARY
  delete process.env.GITHUB_STEP_SUMMARY
  try {
    // Must not throw even though nothing is written anywhere.
    appendStepSummary('some line')
  } finally {
    if (prior !== undefined) process.env.GITHUB_STEP_SUMMARY = prior
  }
})

test('appendStepSummary: appends a line to the file named by GITHUB_STEP_SUMMARY', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acaos-eval-history-'))
  const prior = process.env.GITHUB_STEP_SUMMARY
  try {
    const path = join(dir, 'summary.md')
    writeFileSync(path, '', 'utf8')
    process.env.GITHUB_STEP_SUMMARY = path
    appendStepSummary('first line')
    appendStepSummary('second line')
    assert.equal(readFileSync(path, 'utf8'), 'first line\nsecond line\n')
  } finally {
    if (prior !== undefined) process.env.GITHUB_STEP_SUMMARY = prior
    else delete process.env.GITHUB_STEP_SUMMARY
    rmSync(dir, { recursive: true, force: true })
  }
})

test('appendStepSummary: never throws even if the target path is unwritable (best-effort only)', () => {
  const prior = process.env.GITHUB_STEP_SUMMARY
  try {
    // A path under a directory that does not exist and is never created:
    // appendFileSync will reject, and the function must swallow that.
    process.env.GITHUB_STEP_SUMMARY = join(tmpdir(), 'acaos-eval-history-nonexistent-dir-xyz', 'summary.md')
    appendStepSummary('should not throw')
  } finally {
    if (prior !== undefined) process.env.GITHUB_STEP_SUMMARY = prior
    else delete process.env.GITHUB_STEP_SUMMARY
  }
})
