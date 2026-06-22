import { prisma } from './prisma.js'

// Stale-SENDING recovery. The send path reserves an outbox row as SENDING, then
// dispatches; a real dispatch flips it to SENT (or FAILED) within seconds. A row
// left SENDING long after is the residue of a worker crash mid-dispatch — and it
// keeps counting against the daily/monthly send cap forever (the cap counts
// SENT+SENDING), silently eroding capacity.
//
// This sweep marks such rows FAILED — fail-closed, exactly matching the existing
// crash-after-claim contract (a SENDING row is never auto-resent), so it can never
// cause a duplicate send. The only effect is to free the reserved cap slot and give
// operators an auditable terminal state instead of a stuck one.

export function staleSendRecoveryMinutes(): number {
  const n = Number(process.env.STALE_SENDING_RECOVERY_MINUTES)
  // Default 120 min: real sends settle in seconds, so 2h is comfortably past any
  // legitimate in-flight dispatch while reclaiming crash residue the same day.
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 120
}

/**
 * Reclaim outbox rows stuck in SENDING past the recovery threshold (by claimedAt),
 * marking them FAILED. Idempotent and safe to run on any interval. Returns the count
 * recovered.
 */
export async function recoverStaleSends(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - staleSendRecoveryMinutes() * 60_000)
  const res = await prisma.outreachSent.updateMany({
    where: { status: 'SENDING', claimedAt: { lt: cutoff } },
    data: { status: 'FAILED', failedAt: now, lastError: 'stale SENDING reclaimed by maintenance sweep' },
  })
  return res.count
}
