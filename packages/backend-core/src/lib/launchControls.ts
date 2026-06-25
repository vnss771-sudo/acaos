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

/**
 * Global kill-switch for the automatic follow-up sender. Unlike the opt-OUT
 * feature flags above, this is opt-IN — DEFAULT OFF — so the send-followup worker
 * never dispatches a sequence step until an operator explicitly turns it on
 * (FOLLOWUPS_ENABLED=true), on top of each campaign's own autoFollowupsEnabled.
 */
export function areFollowupsEnabled(): boolean {
  return parseBool(process.env.FOLLOWUPS_ENABLED, false)
}

/**
 * Opt-IN gate (DEFAULT OFF) for the in-product compliance checks in
 * getSendReadiness (lawful basis recorded, outreach terms accepted, CASL consent
 * for Canada-targeting workspaces). Ships dormant so the schema/API/UI can land
 * without changing send behaviour; flip to true only once the legal copy
 * (sub-processor list, T&Cs, LIA prompts) is signed off.
 */
export function isComplianceGateEnabled(): boolean {
  return parseBool(process.env.COMPLIANCE_GATE_ENABLED, false)
}

export type ReputationGuardMode = 'off' | 'observe' | 'enforce'

/**
 * Sender-reputation circuit-breaker mode (REPUTATION_GUARD_MODE). DEFAULT 'observe':
 * the guard computes and LOGS a degraded reputation but does NOT block sends, so
 * shipping it changes no send behavior — an operator graduates to 'enforce' once
 * the observed numbers look right. 'enforce' halts sending for a workspace whose
 * trailing bounce/complaint rate breaches the threshold; 'off' disables it
 * entirely. Read live so the mode can be changed without a deploy.
 */
export function reputationGuardMode(): ReputationGuardMode {
  const raw = (process.env.REPUTATION_GUARD_MODE || '').trim().toLowerCase()
  if (raw === 'enforce' || raw === 'off') return raw
  return 'observe'
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
