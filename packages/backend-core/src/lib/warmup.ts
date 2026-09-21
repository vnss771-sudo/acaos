// Domain warmup ramp. A freshly-configured sending domain that blasts its full
// daily cap on day one looks like a spammer to mailbox providers and torches its
// reputation. Warmup ramps the effective daily send cap up from a low ceiling over
// a schedule, so volume grows gradually as the domain earns trust.
//
// OPT-IN: warmup only applies when a workspace has a warmupStartedAt set. With it
// null (the default for every existing workspace) there is no ramp and the
// workspace's own dailySendLimit governs — behaviour is unchanged. Pure + clock-
// injectable so the schedule is unit-tested without a database.

// Conservative default ramp (one entry per warmup day). After the last entry the
// ramp is complete and warmup no longer constrains the cap.
const DEFAULT_WARMUP_SCHEDULE = [20, 40, 80, 150, 300, 500, 750, 1000]

/**
 * The warmup schedule as an array of per-day caps. Overridable via WARMUP_SCHEDULE
 * (comma-separated positive integers); a malformed/empty override falls back to the
 * default. Read live so the schedule can change without a deploy.
 */
export function warmupSchedule(): number[] {
  const raw = process.env.WARMUP_SCHEDULE
  if (!raw) return DEFAULT_WARMUP_SCHEDULE
  const parsed = raw
    .split(',')
    .map((s) => Math.floor(Number(s.trim())))
    .filter((n) => Number.isFinite(n) && n > 0)
  return parsed.length > 0 ? parsed : DEFAULT_WARMUP_SCHEDULE
}

/**
 * The warmup-imposed daily send cap for a workspace that started warming at
 * `startedAt`, as of `now`. Day 1 (the first ~24h after startedAt) uses the first
 * schedule entry, day 2 the second, and so on. Returns null once the ramp is
 * complete — warmup no longer constrains and the workspace's own cap governs. A
 * not-yet-started warmup (startedAt in the future) gets the most conservative
 * first-day cap. Pure.
 */
export function warmupDailyCap(
  startedAt: Date,
  now: Date = new Date(),
  schedule: number[] = warmupSchedule(),
): number | null {
  if (schedule.length === 0) return null
  const msPerDay = 24 * 60 * 60 * 1000
  const dayIndex = Math.floor((now.getTime() - startedAt.getTime()) / msPerDay) // 0-based
  if (dayIndex < 0) return schedule[0] // future start → most conservative
  if (dayIndex >= schedule.length) return null // ramp complete
  return schedule[dayIndex]
}

/**
 * Combine a workspace's (already safe-launch-clamped) daily limit with its warmup
 * cap. Returns the more restrictive of the two. Either may be null (no limit);
 * warmup wins only while it's active and lower.
 */
export function applyWarmupCap(
  baseLimit: number | null,
  warmupStartedAt: Date | null | undefined,
  now: Date = new Date(),
): number | null {
  if (!warmupStartedAt) return baseLimit
  const warmCap = warmupDailyCap(warmupStartedAt, now)
  if (warmCap == null) return baseLimit
  return baseLimit == null ? warmCap : Math.min(baseLimit, warmCap)
}

export interface WarmupStatus {
  active: boolean // a warmupStartedAt is set at all
  startedAt: string | null // ISO timestamp, or null if never started
  day: number | null // 1-based current ramp day while active and not yet complete; null otherwise
  totalDays: number // length of the schedule (informational, always present)
  cap: number | null // today's warmup-imposed cap; null once complete or inactive
  complete: boolean // active, and the ramp has run its full length
}

/**
 * Human/UI-facing warmup status for a workspace, derived from the same pure
 * schedule logic `applyWarmupCap` uses. Read-only summary — never itself starts,
 * stops, or otherwise mutates warmup state. Pure + clock-injectable.
 */
export function warmupStatus(
  startedAt: Date | null | undefined,
  now: Date = new Date(),
  schedule: number[] = warmupSchedule(),
): WarmupStatus {
  const totalDays = schedule.length
  if (!startedAt) {
    return { active: false, startedAt: null, day: null, totalDays, cap: null, complete: false }
  }
  const cap = warmupDailyCap(startedAt, now, schedule)
  if (cap == null) {
    return { active: true, startedAt: startedAt.toISOString(), day: null, totalDays, cap: null, complete: true }
  }
  const dayIndex = Math.max(0, Math.floor((now.getTime() - startedAt.getTime()) / (24 * 60 * 60 * 1000)))
  return { active: true, startedAt: startedAt.toISOString(), day: dayIndex + 1, totalDays, cap, complete: false }
}
