#!/usr/bin/env node
/**
 * Inspect and remediate a BullMQ queue's failed-job set (ACAOS has no separate
 * literal "dead letter queue" — a DLQ here just means the jobs sitting in a
 * queue's `failed` state after exhausting their retries; see queues.ts's
 * `removeOnFail` retention).
 *
 * Usage:
 *   node scripts/queue-drain.mjs list <queue> [--limit=20]
 *   node scripts/queue-drain.mjs retry <queue> [--limit=N] [--reason=<substring>] [--jobId=<id>] --yes
 *   node scripts/queue-drain.mjs drain <queue> [--limit=N] [--reason=<substring>] [--jobId=<id>] --yes
 *
 * `list`  — summary counts (waiting/active/completed/failed/delayed) plus a
 *           breakdown of failed jobs grouped by error message, and the most
 *           recent failed jobs individually (id, name, attempts, reason, when).
 * `retry` — re-enqueues matching failed jobs (BullMQ's `job.retry()`), for
 *           transient failures (a provider outage, a since-fixed bug).
 * `drain` — permanently removes matching failed jobs (`job.remove()`), for
 *           unrecoverable jobs (bad payload, a workspace that no longer
 *           exists) that would otherwise sit in the failed set forever.
 *
 * `retry`/`drain` are dry-run by default — they print what WOULD be affected
 * and exit without changing anything. Pass --yes to actually apply.
 *
 * Without --jobId or --reason, `retry`/`drain` target every failed job in the
 * queue; --limit caps how many are considered per run (most useful with
 * --reason, to work through a backlog in batches).
 *
 * Requires a reachable REDIS_URL. Run via:
 *   NODE_OPTIONS=--conditions=acaos-src npx tsx scripts/queue-drain.mjs ...   (dev, from source)
 *   node scripts/queue-drain.mjs ...                                          (after `npm run build`)
 */
import { getQueue, getRedisConnection } from '@acaos/backend-core/lib/queues.js'

const KNOWN_QUEUES = [
  'research-lead', 'generate-outreach', 'analyze-reply', 'sync-mailbox',
  'send-campaign', 'score-prospects', 'calibrate-scoring', 'generate-recommendations',
  'discover-prospects', 'retention-purge', 'send-followup',
]

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : undefined
}
function flag(name) {
  return process.argv.includes(`--${name}`)
}

function usageAndExit(code) {
  console.error('Usage: node scripts/queue-drain.mjs <list|retry|drain> <queue> [--limit=N] [--reason=<substring>] [--jobId=<id>] [--yes]')
  console.error(`Known queues: ${KNOWN_QUEUES.join(', ')}`)
  process.exit(code)
}

const [, , command, queueName] = process.argv
if (!command || !['list', 'retry', 'drain'].includes(command)) usageAndExit(2)
if (!queueName) usageAndExit(2)
if (!KNOWN_QUEUES.includes(queueName)) {
  console.error(`[queue-drain] Warning: "${queueName}" is not in the known queue list — proceeding anyway (it may still exist in Redis).`)
}

const limit = Number(arg('limit') ?? 20)
if (!Number.isFinite(limit) || limit <= 0) {
  console.error(`Invalid --limit: ${arg('limit')}`)
  process.exit(2)
}
const reasonFilter = arg('reason')
const jobIdFilter = arg('jobId')
const apply = flag('yes')

function jobMatches(job) {
  if (jobIdFilter) return job.id === jobIdFilter
  if (reasonFilter) return typeof job.failedReason === 'string' && job.failedReason.includes(reasonFilter)
  return true
}

async function fetchFailed(queue, take) {
  // BullMQ's getFailed(start, end) is an inclusive Redis ZRANGE-style range —
  // fetch newest-first (most actionable) up to `take`.
  return queue.getFailed(0, Math.max(0, take - 1), false)
}

async function cmdList(queue) {
  const counts = await queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed')
  console.log(`[queue-drain] ${queueName}: ${JSON.stringify(counts)}`)

  const totalFailed = counts.failed ?? 0
  if (totalFailed === 0) {
    console.log('[queue-drain] No failed jobs.')
    return
  }

  // Sample up to 500 failed jobs to build the reason breakdown so a huge
  // backlog doesn't require loading every job into memory at once.
  const sample = await fetchFailed(queue, Math.min(totalFailed, 500))
  const byReason = new Map()
  for (const job of sample) {
    const reason = (job.failedReason ?? '(no reason recorded)').split('\n')[0].slice(0, 200)
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1)
  }
  console.log(`\n[queue-drain] Failure reasons (top of ${sample.length} sampled of ${totalFailed} total):`)
  for (const [reason, count] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${count.toString().padStart(4)}  ${reason}`)
  }

  const recent = sample.slice(0, limit)
  console.log(`\n[queue-drain] Most recent ${recent.length} failed job(s):`)
  for (const job of recent) {
    const when = job.finishedOn ? new Date(job.finishedOn).toISOString() : '(unknown)'
    console.log(`  id=${job.id} name=${job.name} attempts=${job.attemptsMade} failedAt=${when} reason=${(job.failedReason ?? '').split('\n')[0].slice(0, 200)}`)
  }
}

async function cmdRetryOrDrain(queue, mode) {
  const candidates = (await fetchFailed(queue, Math.max(limit, 500))).filter(jobMatches).slice(0, limit)

  if (candidates.length === 0) {
    console.log('[queue-drain] No failed jobs match the given filter.')
    return
  }

  console.log(`[queue-drain] ${apply ? 'Applying' : 'DRY RUN — would apply'} ${mode} to ${candidates.length} job(s) in "${queueName}":`)
  for (const job of candidates) {
    console.log(`  id=${job.id} name=${job.name} attempts=${job.attemptsMade} reason=${(job.failedReason ?? '').split('\n')[0].slice(0, 200)}`)
  }

  if (!apply) {
    console.log('\n[queue-drain] Dry run only — pass --yes to actually apply this.')
    return
  }

  let ok = 0
  let failed = 0
  for (const job of candidates) {
    try {
      if (mode === 'retry') await job.retry('failed')
      else await job.remove()
      ok += 1
    } catch (err) {
      failed += 1
      console.error(`[queue-drain] Failed to ${mode} job ${job.id}:`, err instanceof Error ? err.message : err)
    }
  }
  console.log(`[queue-drain] Done: ${ok} succeeded, ${failed} failed.`)
}

const queue = getQueue(queueName)
try {
  if (command === 'list') await cmdList(queue)
  else await cmdRetryOrDrain(queue, command)
  process.exitCode = 0
} catch (err) {
  console.error('[queue-drain] Fatal error:', err)
  process.exitCode = 1
} finally {
  await queue.close()
  getRedisConnection().disconnect()
}
