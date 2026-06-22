// Opt-in send window (quiet hours). Sending at 3am local time — or on a weekend
// for a B2B audience — hurts engagement and looks bad to mailbox providers. A
// workspace can restrict outbound to a daily window in a chosen timezone.
//
// OPT-IN: a window exists only when both hours are configured on the workspace ICP.
// With them null (the default) there is no restriction and send timing is unchanged.
// Pure + clock-injectable so the windowing is unit-tested without mocking the clock.

export interface SendWindowConfig {
  startHour: number // 0–23, inclusive
  endHour: number // 1–24, exclusive
  timeZone: string // IANA, e.g. 'America/New_York'
  weekdaysOnly: boolean
}

// The subset of WorkspaceICP fields that define a send window.
export interface SendWindowIcpFields {
  sendWindowStartHour?: number | null
  sendWindowEndHour?: number | null
  sendTimezone?: string | null
  sendWeekdaysOnly?: boolean | null
}

/**
 * Resolve a workspace's send-window config, or null when none is configured (both
 * hours must be present and valid). Defensive: out-of-range hours → null (treated
 * as unconfigured, so a bad value never silently blocks all sends).
 */
export function resolveSendWindow(icp: SendWindowIcpFields | null | undefined): SendWindowConfig | null {
  if (!icp) return null
  const startHour = icp.sendWindowStartHour
  const endHour = icp.sendWindowEndHour
  if (startHour == null || endHour == null) return null
  if (!Number.isInteger(startHour) || !Number.isInteger(endHour)) return null
  if (startHour < 0 || startHour > 23 || endHour < 1 || endHour > 24) return null
  return {
    startHour,
    endHour,
    timeZone: (icp.sendTimezone && icp.sendTimezone.trim()) || 'UTC',
    weekdaysOnly: Boolean(icp.sendWeekdaysOnly),
  }
}

/**
 * The local hour (0–23) and weekday (0=Sun..6=Sat) of `now` in `timeZone`, via
 * Intl (full ICU). Throws on an invalid timeZone — callers treat that as fail-open.
 */
export function localHourAndWeekday(now: Date, timeZone: string): { hour: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour12: false, hour: '2-digit', weekday: 'short' }).formatToParts(now)
  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10) % 24 // some impls render midnight as '24'
  const wd = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun'
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return { hour, weekday: map[wd] ?? 0 }
}

/**
 * Whether `now` falls inside the send window. FAIL-OPEN: a misconfigured window
 * (start >= end) or an invalid timezone returns true (no restriction) rather than
 * blocking every send. Weekend sends are blocked only when weekdaysOnly is set.
 */
export function isWithinSendWindow(now: Date, cfg: SendWindowConfig): boolean {
  if (cfg.startHour >= cfg.endHour) return true // misconfigured → no constraint
  let local: { hour: number; weekday: number }
  try {
    local = localHourAndWeekday(now, cfg.timeZone)
  } catch {
    return true // bad timezone → fail open, never block on config error
  }
  if (cfg.weekdaysOnly && (local.weekday === 0 || local.weekday === 6)) return false
  return local.hour >= cfg.startHour && local.hour < cfg.endHour
}
