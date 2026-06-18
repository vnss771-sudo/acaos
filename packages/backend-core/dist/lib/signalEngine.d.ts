export type SignalType = 'HIRING' | 'FUNDING' | 'EXPANSION' | 'TECH_ADOPTION' | 'LEADERSHIP_CHANGE' | 'NEWS_MENTION' | 'PROCUREMENT' | 'BUSINESS_REGISTRATION' | 'WEBSITE_CHANGE';
export type BuyingStage = 'RESEARCHING' | 'EVALUATING' | 'COMPARING' | 'PURCHASING' | 'INACTIVE';
export type OutcomeStage = 'DISCOVERED' | 'VIEWED' | 'CONTACTED' | 'MEETING' | 'PROPOSAL' | 'WON' | 'LOST';
export declare const EVENT_BASE_WEIGHTS: Record<SignalType, number>;
export type RawSignal = {
    type: SignalType;
    strength: number;
    sourceReliability: number;
    industryRelevance: number;
    detectedAt: Date;
};
export declare function decayedStrength(signal: RawSignal): number;
export type Freshness = 'LIVE' | 'RECENT' | 'STALE' | 'EXPIRED';
export declare function freshnessState(signal: Pick<RawSignal, 'type' | 'detectedAt'>, now?: number): Freshness;
export type CorroborationLevel = 'none' | 'single' | 'promising' | 'urgent';
/** Count of DISTINCT signal types on a company (repeats of one type don't corroborate). */
export declare function distinctSignalTypes(signals: RawSignal[]): number;
/**
 * Corroboration: multiple *different* signals pointing at the same company are
 * far stronger evidence than repeats of one. 1 type = interesting, 2 = promising,
 * 3+ = urgent. Used to label opportunities and to boost intent.
 */
export declare function corroborationLevel(signals: RawSignal[]): {
    distinctTypes: number;
    level: CorroborationLevel;
};
export type ProspectMeta = {
    industry?: string | null;
    employeeCount?: number | null;
    contactEmail?: string | null;
    contactName?: string | null;
    domain?: string | null;
    location?: string | null;
};
export type ICPConfig = {
    targetIndustries: string[];
    minEmployees?: number;
    maxEmployees?: number;
    targetGeos: string[];
    mustHaveEmail: boolean;
};
export type SignalWeights = Partial<Record<SignalType, number>>;
export type OpportunityScores = {
    intentScore: number;
    fitScore: number;
    timingScore: number;
    confidenceScore: number;
    opportunityScore: number;
};
export declare function calculateOpportunityScores(signals: RawSignal[], meta: ProspectMeta, icp?: ICPConfig, signalWeights?: SignalWeights): OpportunityScores;
export declare function detectBuyingStage(signals: RawSignal[], opportunityScore: number): BuyingStage;
export declare function calcWinProbability(stage: BuyingStage, opportunityScore: number): number;
export declare function getOpportunityTier(score: number): 'HOT' | 'WARM' | 'COLD';
export type RecommendationInput = {
    bestContact: string;
    bestTiming: string;
    bestChannel: string;
    messageAngle: string;
    reasoning: string;
    actionText: string;
    urgency: string;
    priority: number;
};
export declare function generateRuleBasedRecommendation(meta: ProspectMeta & {
    contactPhone?: string | null;
    linkedinUrl?: string | null;
}, signals: RawSignal[]): RecommendationInput;
export declare function toRawSignal(s: {
    type: SignalType;
    strength: number;
    sourceReliability: number;
    industryRelevance: number;
    detectedAt: Date;
}): RawSignal;
export declare function predictBuyingIntent(signals: RawSignal[], currentStage: BuyingStage | string, opportunityScore: number): {
    predictedStage: BuyingStage;
    confidence: number;
    trajectory: 'ACCELERATING' | 'STABLE' | 'DECELERATING';
    nextAction: string;
};
