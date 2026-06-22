import { prisma } from './prisma.js'
import { normalizeEmail } from './normalize.js'

export type SendReason =
  | 'WORKSPACE_PAUSED'
  | 'WORKSPACE_BILLING_INACTIVE'
  | 'EMAIL_UNVERIFIED'
  | 'DOMAIN_UNHEALTHY'
  | 'DAILY_CAP_EXCEEDED'
  | 'ALREADY_SENT'
  | 'SUPPRESSED'
  | 'CONTACTED_RECENTLY'
  | 'CAMPAIGN_PAUSED'
  | 'MISSION_PAUSED'
  | 'LEAD_NOT_FOUND'
  | 'DRAFT_NOT_READY'
  | 'SAFE_LAUNCH_MODE_BLOCKED'

export type SendDecision =
  | { allowed: true }
  | { allowed: false; reason: SendReason }

export interface SendEligibilityInput {
  workspaceId: string
  campaignId: string
  leadId: string
  draftStatus?: string | null
  safeLaunchMode?: boolean
}

export async function canSendOutreach(input: SendEligibilityInput): Promise<SendDecision> {
  const { workspaceId, campaignId, leadId, draftStatus, safeLaunchMode } = input

  // 1. Check workspace exists and billing is active
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, subscriptionStatus: true, plan: true }
  })
  if (!workspace) {
    return { allowed: false, reason: 'WORKSPACE_PAUSED' }
  }
  if (workspace.subscriptionStatus !== 'active' && workspace.plan !== 'free') {
    return { allowed: false, reason: 'WORKSPACE_BILLING_INACTIVE' }
  }

  // 2. Check workspace email is verified
  const emailConfig = await prisma.workspaceEmailConfig.findUnique({
    where: { workspaceId },
    select: { id: true }
  })
  if (!emailConfig) {
    return { allowed: false, reason: 'EMAIL_UNVERIFIED' }
  }

  // 3. Check lead exists and has a deliverable email address
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { id: true, email: true }
  })
  if (!lead || !lead.email) {
    return { allowed: false, reason: 'LEAD_NOT_FOUND' }
  }

  // 4. Check not already sent (idempotency check). Any step counts — if the lead
  //    has any send for this campaign, the initial outreach already went out.
  const existing = await prisma.outreachSent.findFirst({
    where: { campaignId, leadId },
    select: { id: true },
  })
  if (existing) {
    return { allowed: false, reason: 'ALREADY_SENT' }
  }

  // 5. Check suppression status (normalized emailKey — same key suppress() writes)
  const suppressed = await prisma.suppression.findUnique({
    where: { workspaceId_emailKey: { workspaceId, emailKey: normalizeEmail(lead.email) } }
  })
  if (suppressed) {
    return { allowed: false, reason: 'SUPPRESSED' }
  }

  // 6. Check campaign exists and its mission is not paused/complete.
  // A campaign may have no mission (legacy/direct campaigns); only an explicit
  // PAUSED/COMPLETE mission blocks — a missing mission is not a stop signal.
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { id: true }
  })
  if (!campaign) {
    return { allowed: false, reason: 'CAMPAIGN_PAUSED' }
  }

  const mission = await prisma.mission.findUnique({
    where: { campaignId: campaign.id },
    select: { status: true }
  })
  if (mission && (mission.status === 'PAUSED' || mission.status === 'COMPLETE')) {
    return { allowed: false, reason: 'MISSION_PAUSED' }
  }

  // 7. Check draft status if approval mode is enabled
  const workspaceIcp = await prisma.workspaceICP.findUnique({
    where: { workspaceId },
    select: { approvalMode: true }
  })
  if (workspaceIcp?.approvalMode && draftStatus !== 'APPROVED') {
    return { allowed: false, reason: 'DRAFT_NOT_READY' }
  }

  // 8. Safe launch mode check
  if (safeLaunchMode) {
    const sentToday = await prisma.outreachSent.count({
      where: {
        workspaceId,
        status: 'SENT',
        sentAt: {
          gte: new Date(new Date().setHours(0, 0, 0, 0))
        }
      }
    })
    // Default cap: 20/day in safe launch mode
    const SAFE_LAUNCH_CAP = parseInt(process.env.SAFE_LAUNCH_DAILY_SEND_CAP || '20', 10)
    if (sentToday >= SAFE_LAUNCH_CAP) {
      return { allowed: false, reason: 'SAFE_LAUNCH_MODE_BLOCKED' }
    }
  }

  // 9. Daily send limit check (standard mode)
  if (!safeLaunchMode) {
    const workspaceLimit = await prisma.workspaceICP.findUnique({
      where: { workspaceId },
      select: { dailySendLimit: true }
    })
    if (workspaceLimit?.dailySendLimit) {
      const sentToday = await prisma.outreachSent.count({
        where: {
          workspaceId,
          status: 'SENT',
          sentAt: {
            gte: new Date(new Date().setHours(0, 0, 0, 0))
          }
        }
      })
      if (sentToday >= workspaceLimit.dailySendLimit) {
        return { allowed: false, reason: 'DAILY_CAP_EXCEEDED' }
      }
    }
  }

  return { allowed: true }
}

/**
 * Get a human-readable message for why send was blocked.
 * Used in API responses and admin dashboards.
 */
export function getSendBlockMessage(reason: SendReason): string {
  const messages: Record<SendReason, string> = {
    WORKSPACE_PAUSED: 'Workspace is paused or does not exist',
    WORKSPACE_BILLING_INACTIVE: 'Billing is inactive; subscription required to send',
    EMAIL_UNVERIFIED: 'Workspace email is not verified',
    DOMAIN_UNHEALTHY: 'Sender domain health check failed',
    DAILY_CAP_EXCEEDED: 'Daily send limit reached',
    ALREADY_SENT: 'Email already sent to this lead',
    SUPPRESSED: 'Lead email is suppressed (unsubscribed or bounced)',
    CONTACTED_RECENTLY: 'Lead was contacted recently',
    CAMPAIGN_PAUSED: 'Campaign is paused',
    MISSION_PAUSED: 'Mission is paused',
    LEAD_NOT_FOUND: 'Lead not found',
    DRAFT_NOT_READY: 'Draft not approved; approval required before send',
    SAFE_LAUNCH_MODE_BLOCKED: 'Safe launch daily limit reached'
  }
  return messages[reason] || 'Send not allowed'
}
