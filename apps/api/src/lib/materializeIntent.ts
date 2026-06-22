// Option A: turn an APPROVED OutreachIntent into something the proven send path
// can dispatch — a Lead + an APPROVED OutreachDraft in a Campaign — and link it
// back to the intent so the worker stamps provenance and flips it to SENT.
// This closes the last manual seam between the intelligence track and sending.
import { prisma } from './prisma.js'
import { normalizeEmailKey } from '@acaos/backend-core/lib/normalize.js'

const DEFAULT_CAMPAIGN_NAME = 'ACAOS Radar'

// Use a caller-supplied campaign, else find-or-create the workspace's default
// radar campaign so materialised intents always have somewhere to live.
async function resolveCampaignId(workspaceId: string, campaignId?: string | null): Promise<string> {
  if (campaignId) return campaignId
  const existing = await prisma.campaign.findFirst({ where: { workspaceId, name: DEFAULT_CAMPAIGN_NAME }, select: { id: true } })
  if (existing) return existing.id
  const created = await prisma.campaign.create({
    data: { workspaceId, name: DEFAULT_CAMPAIGN_NAME, goalType: 'BOOK_CALL', description: 'Auto-created for materialised acquisition-radar intents' },
    select: { id: true },
  })
  return created.id
}

export async function materializeOutreachIntent(args: {
  intent: {
    id: string; workspaceId: string; leadId: string | null
    draftSubject: string | null; draftBody: string | null; draftFollowup: string | null
  }
  prospect: { companyName: string; contactEmail: string | null; contactName: string | null; domain: string | null; location: string | null; industry: string | null }
  campaignId?: string | null
}): Promise<{ leadId: string; campaignId: string; draftId: string }> {
  const { intent, prospect } = args
  const workspaceId = intent.workspaceId
  const campaignId = await resolveCampaignId(workspaceId, args.campaignId)

  // Reuse the intent's lead, else an existing lead with the same email, else create.
  let leadId = intent.leadId ?? null
  if (!leadId && prospect.contactEmail) {
    const existing = await prisma.lead.findFirst({ where: { workspaceId, email: prospect.contactEmail }, select: { id: true } })
    leadId = existing?.id ?? null
  }
  if (leadId) {
    await prisma.lead.update({ where: { id: leadId }, data: { campaignId } })
  } else {
    const lead = await prisma.lead.create({
      data: {
        workspaceId, campaignId,
        businessName: prospect.companyName,
        email: prospect.contactEmail,
        emailKey: normalizeEmailKey(prospect.contactEmail),
        contactName: prospect.contactName,
        website: prospect.domain,
        city: prospect.location,
        category: prospect.industry,
        sourceTag: 'acaos-intent',
        stage: 'NEW',
      },
      select: { id: true },
    })
    leadId = lead.id
  }

  // APPROVED draft from the intent's reviewed copy, so the approval-mode worker
  // will actually send it.
  const draft = await prisma.outreachDraft.create({
    data: {
      leadId, workspaceId,
      subject: intent.draftSubject ?? '(no subject)',
      emailBody: intent.draftBody ?? '',
      followup: intent.draftFollowup ?? null,
      status: 'APPROVED',
      reviewedAt: new Date(),
    },
    select: { id: true },
  })

  // Link the intent so the send path (Stage 5) can find + stamp it.
  await prisma.outreachIntent.update({ where: { id: intent.id }, data: { leadId, campaignId } })

  if (!leadId) throw new Error('materializeOutreachIntent invariant: leadId was not resolved')
  return { leadId, campaignId, draftId: draft.id }
}
