export type ScoringWeights = {
    industry: number;
    size: number;
    hiring: number;
    tech: number;
    growth: number;
    contact: number;
    messageRelevance: number;
    channelFit: number;
    timingFit: number;
    dataFreshness: number;
};
export declare const DEFAULT_SCORING_WEIGHTS: ScoringWeights;
type LeadInput = {
    category?: string | null;
    businessName: string;
    contactName?: string | null;
    email?: string | null;
    website?: string | null;
    notes?: string | null;
    aiSummary?: string | null;
    outreachAngle?: string | null;
};
export declare function computeLeadScore(lead: LeadInput, weights?: ScoringWeights): number;
export declare function getScoreTier(score: number): 'HOT' | 'WARM' | 'COLD';
export declare const TIER_COLOR: Record<string, string>;
export {};
