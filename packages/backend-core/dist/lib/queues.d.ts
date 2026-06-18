import { Queue } from 'bullmq';
export declare function getQueue(name: string): Queue;
export declare function enqueueResearchLead(opts: {
    leadId: string;
    workspaceId: string;
    initiatedByUserId?: string;
}): Promise<import("bullmq").Job<any, any, string>>;
export declare function enqueueGenerateOutreach(opts: {
    leadId: string;
    workspaceId: string;
    initiatedByUserId?: string;
}): Promise<import("bullmq").Job<any, any, string>>;
export declare function enqueueAnalyzeReply(opts: {
    replyBody: string;
    workspaceId: string;
    leadId?: string;
    initiatedByUserId?: string;
}): Promise<import("bullmq").Job<any, any, string>>;
export declare function enqueueSyncMailbox(workspaceId: string, userId?: string): Promise<import("bullmq").Job<any, any, string>>;
export declare function getJobById(queueName: string, jobId: string): Promise<import("bullmq").Job<any, any, string> | undefined>;
export declare function enqueueScoreProspects(workspaceId: string): Promise<import("bullmq").Job<any, any, string>>;
export declare function enqueueGenerateRecommendations(prospectId: string, workspaceId: string): Promise<import("bullmq").Job<any, any, string>>;
export declare function enqueueCalibrate(workspaceId: string): Promise<import("bullmq").Job<any, any, string>>;
export declare function enqueueSendCampaign(campaignId: string, workspaceId: string, leadIds?: string[]): Promise<import("bullmq").Job<any, any, string>>;
export declare function getQueueStats(): Promise<{
    name: string;
}[]>;
