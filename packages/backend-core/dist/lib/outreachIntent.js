// Stage 2 of the OutreachIntent bridge: when a Recommendation is created, also
// create an OutreachIntent (PROPOSED) carrying a point-in-time evidence snapshot
// — the auditable "what we knew when we recommended this". Best-effort by design:
// callers wrap it so a bridge write never breaks the primary recommendation path.
import { prisma } from './prisma.js';
import { freshnessState } from './signalEngine.js';
/** Compact, auditable record of the signals that justified a recommendation. */
export function buildEvidenceSnapshot(signals) {
    return {
        capturedAt: new Date().toISOString(),
        signalCount: signals.length,
        signals: signals.map((s) => ({
            type: s.type,
            title: s.title ?? null,
            source: s.source ?? null,
            detectedAt: s.detectedAt.toISOString(),
            freshness: freshnessState({ type: s.type, detectedAt: s.detectedAt }),
            hasEvidence: !!s.evidenceSourceId,
        })),
    };
}
export async function createOutreachIntentForRecommendation(input) {
    return prisma.outreachIntent.create({
        data: {
            workspaceId: input.workspaceId,
            prospectId: input.prospectId,
            recommendationId: input.recommendationId,
            status: 'PROPOSED',
            messageAngle: input.messageAngle ?? null,
            channel: input.channel ?? null,
            evidenceSnapshot: buildEvidenceSnapshot(input.signals),
            missionId: input.missionId ?? null,
            campaignId: input.campaignId ?? null,
        },
    });
}
/**
 * Build the outreach-generation input from an intent's evidence context — the
 * "draft from evidence" path. The recommendation's reasoning becomes the
 * research summary; the intent's angle (or the recommendation's) is the hook;
 * industry comes from the prospect, never the seller's ICP.
 */
export function buildIntentDraftInput(args) {
    return {
        businessName: args.prospect.companyName,
        category: args.prospect.industry ?? undefined,
        city: args.prospect.location ?? undefined,
        contactName: args.prospect.contactName ?? undefined,
        aiSummary: args.recommendation?.reasoning ?? undefined,
        outreachAngle: args.intent.messageAngle ?? args.recommendation?.messageAngle ?? undefined,
        icp: args.icp,
    };
}
