// Launch blast-radius controls.
//
// Two independent levers an operator can pull WITHOUT a deploy (env only):
//
//  1. Per-feature kill-switches (FEATURE_AI / FEATURE_SEND / FEATURE_MAILBOX_SYNC
//     / FEATURE_DISCOVERY). Default ON, so an existing deploy is unchanged and an
//     operator opts OUT explicitly. The API rejects a disabled feature at the
//     edge (503) and the worker skips a disabled job — same source of truth here
//     so the two layers can never disagree.
//
//  2. SAFE_LAUNCH_MODE (default OFF). A single switch that forces conservative
//     defaults during an early/controlled launch: outbound requires human
//     approval, auto-send is off, and the per-workspace daily send cap is clamped
//     to a low ceiling — regardless of each workspace's own settings.
//
// Everything is read live from the environment (no caching) so flipping a switch
// takes effect on the next request/job without a restart.

export type Feature = 'ai' | 'send' | 'mailboxSync' | 'discovery'

// The env var backing each feature kill-switch.
const FEATURE_ENV: Record<Feature, string> = {
  ai: 'FEATURE_AI',
  send: 'FEATURE_SEND',
  mailboxSync: 'FEATURE_MAILBOX_SYNC',
  discovery: 'FEATURE_DISCOVERY',
}

// Human-readable label per feature for the 503 message / log lines.
export const FEATURE_LABEL: Record<Feature, string> = {
  ai: 'AI features',
  send: 'Email sending',
  mailboxSync: 'Mailbox sync',
  discovery: 'Prospect discovery',
}

// Tri-state boolean env parse: recognized true/false tokens win; anything else
// (unset, empty, unrecognized) falls back to the provided default.
function parseBool(raw: string | undefined, dflt: boolean): boolean {
  if (raw === undefined) return dflt
  const s = raw.trim().toLowerCase()
  if (s === '') return dflt
  if (s === 'true' || s === '1' || s === 'on' || s === 'yes') return true
  if (s === 'false' || s === '0' || s === 'off' || s === 'no') return false
  return dflt
}

/** Whether a feature is enabled. Default ON — operators opt OUT explicitly. */
export function isFeatureEnabled(feature: Feature): boolean {
  return parseBool(process.env[FEATURE_ENV[feature]], true)
}

/** SAFE_LAUNCH_MODE master switch. Default OFF. */
export function isSafeLaunchMode(): boolean {
  return parseBool(process.env.SAFE_LAUNCH_MODE, false)
}

// The low daily send ceiling applied to EVERY workspace while safe-launch is on.
// Overridable via SAFE_LAUNCH_DAILY_SEND_CAP; a non-positive/invalid value falls
// back to the default.
const DEFAULT_SAFE_DAILY_SEND_CAP = 20
export function safeLaunchDailySendCap(): number {
  const raw = Number(process.env.SAFE_LAUNCH_DAILY_SEND_CAP)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_SAFE_DAILY_SEND_CAP
}

/**
 * Effective approval mode for a workspace. Safe-launch FORCES human approval of
 * every outbound draft (returns true) no matter the workspace's own setting;
 * otherwise the workspace's setting stands.
 */
export function effectiveApprovalMode(workspaceApprovalMode: boolean): boolean {
  return isSafeLaunchMode() ? true : workspaceApprovalMode
}

/**
 * Effective daily send cap for a workspace. Safe-launch clamps the workspace's
 * own limit down to the low safe ceiling (and imposes the ceiling even when the
 * workspace has no limit set). `workspaceLimit` of null/undefined means "no
 * per-workspace limit". Returns null when no cap applies.
 */
export function effectiveDailySendLimit(workspaceLimit: number | null | undefined): number | null {
  const ws = workspaceLimit ?? null
  if (!isSafeLaunchMode()) return ws
  const cap = safeLaunchDailySendCap()
  return ws == null ? cap : Math.min(ws, cap)
}

/**
 * A JSON-safe snapshot of every control, for an operator status endpoint / log
 * line. Pure read of the current environment.
 */
export function launchControlsSnapshot() {
  return {
    safeLaunchMode: isSafeLaunchMode(),
    safeLaunchDailySendCap: isSafeLaunchMode() ? safeLaunchDailySendCap() : null,
    features: {
      ai: isFeatureEnabled('ai'),
      send: isFeatureEnabled('send'),
      mailboxSync: isFeatureEnabled('mailboxSync'),
      discovery: isFeatureEnabled('discovery'),
    },
  }
}
