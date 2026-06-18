export type IcpContext = {
    targetIndustries?: string[];
    businessType?: string;
    outreachTone?: string;
};
export declare function generateLeadResearch(input: {
    businessName: string;
    website?: string;
    category?: string;
    city?: string;
    notes?: string;
    icp?: IcpContext;
}): Promise<string>;
export type OutreachInput = {
    businessName: string;
    category?: string;
    city?: string;
    contactName?: string;
    aiSummary?: string;
    outreachAngle?: string;
    notes?: string;
    icp?: IcpContext;
};
export declare function buildOutreachUserPrompt(input: OutreachInput): string;
export declare function generateOutreach(input: OutreachInput): Promise<string>;
export declare function analyzeReply(replyBody: string): Promise<string>;
