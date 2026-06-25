// Progressive account lockout for repeated MFA failures.
//
// The IP+account rate limiter slows brute force but never *locks* — a patient
// attacker can keep probing a 6-digit TOTP within the window. This adds a durable,
// per-account backoff that escalates with consecutive failures and resets on the
// first success. The schedule is a pure function so it is fully unit-testable; the
// route layer persists the counter + lock timestamp on the User row.
//
// Thresholds: the first few failures are free (legitimate typos / clock skew), then
// the lock kicks in and lengthens, capped so a locked-out user can always recover.

// Failures strictly below this are not locked at all — the rate limiter handles them.
export const LOCKOUT_THRESHOLD = 5

// Escalating lock windows (seconds) keyed by how many consecutive failures have
// accrued. Chosen so a genuine user fumbling a code is mildly inconvenienced while a
// scripted attacker is throttled to a handful of guesses per hour.
export function lockoutSeconds(consecutiveFailures: number): number {
  if (consecutiveFailures < LOCKOUT_THRESHOLD) return 0
  if (consecutiveFailures < 7) return 60          // 5–6 → 1 min
  if (consecutiveFailures < 10) return 5 * 60     // 7–9 → 5 min
  if (consecutiveFailures < 15) return 15 * 60    // 10–14 → 15 min
  return 30 * 60                                  // 15+ → 30 min (cap)
}

export type LockoutState = { failedAttempts: number; lockedUntil: Date | null }

/** Whether an account is currently locked, given its state and the current time. */
export function isLocked(state: { lockedUntil: Date | null }, now: Date): boolean {
  return state.lockedUntil !== null && state.lockedUntil.getTime() > now.getTime()
}

/** Seconds remaining on a lock (for a Retry-After header); 0 if not locked. */
export function lockRetryAfterSeconds(state: { lockedUntil: Date | null }, now: Date): number {
  if (!isLocked(state, now)) return 0
  return Math.ceil((state.lockedUntil!.getTime() - now.getTime()) / 1000)
}

/**
 * Compute the next lockout state after a FAILED attempt: bump the consecutive
 * counter and derive the lock window from the schedule. Pure — the caller persists
 * the result and decides the HTTP response.
 */
export function nextLockoutAfterFailure(currentFailures: number, now: Date): LockoutState {
  const failedAttempts = Math.max(0, currentFailures) + 1
  const secs = lockoutSeconds(failedAttempts)
  return {
    failedAttempts,
    lockedUntil: secs > 0 ? new Date(now.getTime() + secs * 1000) : null,
  }
}

/** The cleared state after a SUCCESSFUL attempt. */
export const CLEARED_LOCKOUT: LockoutState = { failedAttempts: 0, lockedUntil: null }
