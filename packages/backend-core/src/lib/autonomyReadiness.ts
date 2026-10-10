// Autonomous-outreach readiness (UQ-40).
//
// WorkspaceICP.approvalMode=false used to be enough, outside SAFE_LAUNCH_MODE,
// for the worker to send freshly generated copy with no human review. It is now
// only a *request*: automatic sending also needs every condition below, checked
// at send time, and human approval is the answer whenever any one fails.
//
//   AUTONOMOUS_OUTREACH_MODE=active   operator switch, default off
//   FEATURE_SEND on, SAFE_LAUNCH_MODE off, workspace not send-suppressed
//   the workspace opted in to the CURRENT consent version (admin, audited)
//   sender reputation healthy, on at least its minimum sample of sends
//   at least AUTONOMY_MIN_REVIEWED_DRAFTS human-reviewed drafts (default 20)
//   approval rate >= AUTONOMY_MIN_APPROVAL_RATE (default 0.9)
//   policy-review rate <= AUTONOMY_MAX_POLICY_REVIEW_RATE (default 0.05)
//
// The draft rates are a conservative operational proxy for "the copy is
// reliably fine as generated", layered on the existing grounding and policy
// checks — not a claim of semantic correctness.
import { prisma } from './prisma.js'
import { effectiveApprovalMode, isFeatureEnabled, isSafeLaunchMode } from './launchControls.js'
import { evaluateSenderReputation } from './senderReputation.js'

export const AUTONOMY_CONSENT_VERSION = '2026-10-10.v1'
/** Drafts reviewed in this window count toward the quality bar. */
export const AUTONOMY_WINDOW_DAYS = 90

export type AutonomyMode = 'off' | 'active'

export type AutonomyBlocker =
  | 'MODE_OFF' | 'SENDING_DISABLED' | 'SAFE_LAUNCH' | 'WORKSPACE_SUPPRESSED' | 'NOT_OPTED_IN'
  | 'REPUTATION_SAMPLE_LOW' | 'REPUTATION_UNHEALTHY'
  | 'TOO_FEW_REVIEWED_DRAFTS' | 'APPROVAL_RATE_LOW' | 'POLICY_REVIEW_RATE_HIGH'

export type AutonomyAssessment = {
  ready: boolean
  mode: AutonomyMode
  blockers: AutonomyBlocker[]
  optedIn: boolean
  optInAt: string | null
  consentVersion: string
  metrics: {
    reviewedDrafts: number
    approvalRate: number | null
    policyReviewRate: number | null
    sends: number
    bounceRate: number
    complaintRate: number
  }
  thresholds: { minReviewedDrafts: number; minApprovalRate: number; maxPolicyReviewRate: number; minSends: number }
}

export function autonomousOutreachMode(): AutonomyMode {
  return process.env.AUTONOMOUS_OUTREACH_MODE?.trim().toLowerCase() === 'active' ? 'active' : 'off'
}

function envNumber(name: string, dflt: number, min: number, max: number): number {
  const n = Number(process.env[name])
  return process.env[name] != null && Number.isFinite(n) && n >= min && n <= max ? n : dflt
}

export function autonomyThresholds() {
  return {
    // 0 drops the draft-history requirement (not recommended; used by send-pipeline tests).
    minReviewedDrafts: Math.round(envNumber('AUTONOMY_MIN_REVIEWED_DRAFTS', 20, 0, 100_000)),
    minApprovalRate: envNumber('AUTONOMY_MIN_APPROVAL_RATE', 0.9, 0, 1),
    maxPolicyReviewRate: envNumber('AUTONOMY_MAX_POLICY_REVIEW_RATE', 0.05, 0, 1),
  }
}

const rate = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 1000) / 1000)

export async function assessAutonomy(workspaceId: string, now: Date = new Date()): Promise<AutonomyAssessment> {
  const mode = autonomousOutreachMode()
  const t = autonomyThresholds()
  const since = new Date(now.getTime() - AUTONOMY_WINDOW_DAYS * 86_400_000)
  const [ws, byStatus, reputation] = await Promise.all([
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { sendSuppressed: true, autonomyOptInAt: true, autonomyConsentVersion: true } }),
    prisma.outreachDraft.groupBy({ by: ['status'], where: { workspaceId, createdAt: { gte: since } }, _count: { _all: true } }),
    evaluateSenderReputation(workspaceId, now),
  ]) as [
    { sendSuppressed: boolean; autonomyOptInAt: Date | null; autonomyConsentVersion: string | null } | null,
    Array<{ status: string; _count: { _all: number } }>,
    Awaited<ReturnType<typeof evaluateSenderReputation>>,
  ]
  const count = (...statuses: string[]) => byStatus.filter(r => statuses.includes(r.status)).reduce((a, r) => a + r._count._all, 0)
  // SENT drafts were sent after approval (or before any autonomy existed): both are human-approved copy.
  const approved = count('APPROVED', 'SENT')
  const rejected = count('REJECTED')
  const policyReview = count('POLICY_REVIEW')
  const reviewedDrafts = approved + rejected
  const approvalRate = rate(approved, reviewedDrafts)
  const policyReviewRate = rate(policyReview, reviewedDrafts + policyReview)
  const optedIn = ws?.autonomyOptInAt != null && ws.autonomyConsentVersion === AUTONOMY_CONSENT_VERSION

  const blockers: AutonomyBlocker[] = []
  if (mode !== 'active') blockers.push('MODE_OFF')
  if (!isFeatureEnabled('send')) blockers.push('SENDING_DISABLED')
  if (isSafeLaunchMode()) blockers.push('SAFE_LAUNCH')
  if (!ws || ws.sendSuppressed) blockers.push('WORKSPACE_SUPPRESSED')
  if (!optedIn) blockers.push('NOT_OPTED_IN')
  if (reputation.totalSends < reputation.thresholds.minSends) blockers.push('REPUTATION_SAMPLE_LOW')
  else if (!reputation.healthy) blockers.push('REPUTATION_UNHEALTHY')
  if (reviewedDrafts < t.minReviewedDrafts) blockers.push('TOO_FEW_REVIEWED_DRAFTS')
  else if (approvalRate != null && approvalRate < t.minApprovalRate) blockers.push('APPROVAL_RATE_LOW')
  if (policyReviewRate != null && policyReviewRate > t.maxPolicyReviewRate) blockers.push('POLICY_REVIEW_RATE_HIGH')

  return {
    ready: blockers.length === 0,
    mode,
    blockers,
    optedIn,
    optInAt: ws?.autonomyOptInAt?.toISOString() ?? null,
    consentVersion: AUTONOMY_CONSENT_VERSION,
    metrics: { reviewedDrafts, approvalRate, policyReviewRate, sends: reputation.totalSends, bounceRate: reputation.bounceRate, complaintRate: reputation.complaintRate },
    thresholds: { ...t, minSends: reputation.thresholds.minSends },
  }
}

/**
 * Whether drafts must be human-approved before sending. The single decision
 * the worker and the campaign API share: approval unless the workspace asked
 * for autonomy (approvalMode=false) AND every readiness condition holds now.
 */
export async function approvalRequiredFor(workspaceId: string, workspaceApprovalMode: boolean): Promise<boolean> {
  if (effectiveApprovalMode(workspaceApprovalMode)) return true
  return !(await assessAutonomy(workspaceId)).ready
}
