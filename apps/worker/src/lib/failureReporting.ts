// Decide whether a BullMQ job failure is a real fault worth reporting to the
// error transport, versus a transient failure that BullMQ will retry. Only the
// final (retries-exhausted) attempt is a fault; earlier attempts are noise.
//
// BullMQ increments `attemptsMade` before emitting 'failed', so on the last
// attempt it equals the configured `attempts` (default 1).
export type FailedJobLike = { attemptsMade: number; opts?: { attempts?: number } }

export function isFinalAttempt(job: FailedJobLike | undefined | null): boolean {
  if (!job) return true
  return job.attemptsMade >= (job.opts?.attempts ?? 1)
}
