import { prisma } from '../lib/prisma.js'
import { isFeatureEnabled, isComplianceGateEnabled, reputationGuardMode } from '../lib/launchControls.js'
import { evaluateSenderReputation } from '../lib/senderReputation.js'
import { hasConsent } from '../lib/consent.js'
import { isSuppressed } from '../lib/suppressions.js'
import { canContactRecipient, type ContactPolicyReason } from './contactPolicy.js'

export type OutboundSendContext = 'campaign' | 'followup' | 'reply'

export type OutboundSendReasonCode =
  | 'ALLOWED'
  | 'FEATURE_SEND_DISABLED'
  | 'WORKSPACE_NOT_FOUND'
  | 'WORKSPACE_SUPPRESSED'
  | 'REPUTATION_BLOCKED'
  | 'RECIPIENT_REQUIRED'
  | 'RECIPIENT_SUPPRESSED'
  | 'CONSENT_REQUIRED'
  | ContactPolicyReason

export interface OutboundSendDecision {
  allowed: boolean
  code: OutboundSendReasonCode
  reasons: OutboundSendReasonCode[]
  policyVersion: 'outbound-send-v1'
  evaluatedAt: Date
  /** Observe-mode reputation findings never block, but remain explainable. */
  observations?: string[]
}

export interface AuthorizeOutboundSendInput {
  workspaceId: string
  context: OutboundSendContext
  email?: string | null
  leadId?: string | null
  /**
   * Campaign batches use existing bulk recipient pre-filters for performance.
   * This flag lets the canonical gate enforce platform/workspace/reputation at
   * batch start while per-recipient suppression/consent remains bulk-checked.
   */
  recipientChecks?: boolean
}

const POLICY_VERSION = 'outbound-send-v1' as const

function deny(code: OutboundSendReasonCode, observations: string[] = []): OutboundSendDecision {
  return {
    allowed: false,
    code,
    reasons: [code],
    policyVersion: POLICY_VERSION,
    evaluatedAt: new Date(),
    ...(observations.length ? { observations } : {}),
  }
}

function allow(observations: string[] = []): OutboundSendDecision {
  return {
    allowed: true,
    code: 'ALLOWED',
    reasons: ['ALLOWED'],
    policyVersion: POLICY_VERSION,
    evaluatedAt: new Date(),
    ...(observations.length ? { observations } : {}),
  }
}

/**
 * Canonical acquisition-email authorization gate.
 *
 * Context matters deliberately:
 * - campaign/followup are cold-outreach paths and use the conservative contact
 *   frequency/terminal-state policy;
 * - reply is a human response to an inbound reply, so applying the cold-contact
 *   "ALREADY_REPLIED" rule would incorrectly block every legitimate reply. It
 *   therefore enforces hard recipient suppression only.
 *
 * This service only answers whether policy allows dispatch. Callers still own
 * content validation, mission/campaign state, pacing/caps, provider config and
 * atomic outbox/idempotency claims that are specific to their workflow.
 */
export async function authorizeOutboundSend(input: AuthorizeOutboundSendInput): Promise<OutboundSendDecision> {
  if (!isFeatureEnabled('send')) return deny('FEATURE_SEND_DISABLED')

  const workspace = await prisma.workspace.findUnique({
    where: { id: input.workspaceId },
    select: { sendSuppressed: true, lawfulBasis: true, targetsCanada: true },
  })
  if (!workspace) return deny('WORKSPACE_NOT_FOUND')
  if (workspace.sendSuppressed) return deny('WORKSPACE_SUPPRESSED')

  const observations: string[] = []
  const guardMode = reputationGuardMode()
  if (guardMode !== 'off') {
    const reputation = await evaluateSenderReputation(input.workspaceId).catch(() => null)
    if (reputation && !reputation.healthy) {
      if (guardMode === 'enforce') return deny('REPUTATION_BLOCKED')
      observations.push(`REPUTATION_DEGRADED:${reputation.reason}`)
    }
  }

  if (input.recipientChecks === false) return allow(observations)
  if (!input.email) return deny('RECIPIENT_REQUIRED', observations)

  if (input.context === 'reply') {
    if (await isSuppressed(input.workspaceId, input.email)) return deny('RECIPIENT_SUPPRESSED', observations)
    return allow(observations)
  }

  const contact = await canContactRecipient({
    workspaceId: input.workspaceId,
    email: input.email,
    leadId: input.leadId,
  })
  if (!contact.allowed) return deny(contact.reason, observations)

  if (isComplianceGateEnabled() && (workspace.lawfulBasis === 'consent' || workspace.targetsCanada === true)) {
    if (!(await hasConsent(input.workspaceId, input.email))) return deny('CONSENT_REQUIRED', observations)
  }

  return allow(observations)
}
