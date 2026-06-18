import { type SignalType } from './signalEngine.js';
import type { OutreachInput, IcpContext } from '../services/openai.js';
export type SnapshotSignal = {
    type: SignalType;
    detectedAt: Date;
    title?: string | null;
    source?: string | null;
    evidenceSourceId?: string | null;
};
/** Compact, auditable record of the signals that justified a recommendation. */
export declare function buildEvidenceSnapshot(signals: SnapshotSignal[]): {
    capturedAt: string;
    signalCount: number;
    signals: {
        type: SignalType;
        title: string | null;
        source: string | null;
        detectedAt: string;
        freshness: import("./signalEngine.js").Freshness;
        hasEvidence: boolean;
    }[];
};
export declare function createOutreachIntentForRecommendation(input: {
    workspaceId: string;
    prospectId: string;
    recommendationId: string;
    messageAngle?: string | null;
    channel?: string | null;
    signals: SnapshotSignal[];
    missionId?: string | null;
    campaignId?: string | null;
}): Promise<{
    id: string;
    workspaceId: string;
    createdAt: Date;
    updatedAt: Date;
    leadId: string | null;
    campaignId: string | null;
    missionId: string | null;
    status: import(".prisma/client").$Enums.OutreachIntentStatus;
    messageAngle: string | null;
    channel: string | null;
    evidenceSnapshot: import("@prisma/client/runtime/library").JsonValue | null;
    draftSubject: string | null;
    draftBody: string | null;
    draftFollowup: string | null;
    draftGeneratedAt: Date | null;
    approvedBy: string | null;
    approvedAt: Date | null;
    prospectId: string;
    recommendationId: string | null;
}>;
/**
 * Build the outreach-generation input from an intent's evidence context — the
 * "draft from evidence" path. The recommendation's reasoning becomes the
 * research summary; the intent's angle (or the recommendation's) is the hook;
 * industry comes from the prospect, never the seller's ICP.
 */
export declare function buildIntentDraftInput(args: {
    prospect: {
        companyName: string;
        industry?: string | null;
        contactName?: string | null;
        location?: string | null;
    };
    recommendation?: {
        reasoning?: string | null;
        messageAngle?: string | null;
    } | null;
    intent: {
        messageAngle?: string | null;
    };
    icp?: IcpContext;
}): OutreachInput;
