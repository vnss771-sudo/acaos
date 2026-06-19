// Lead ICP scoring — maps available lead fields to signal vectors
// Uses the same weight schema as ScorerV2 / outcomes.ts
export const DEFAULT_SCORING_WEIGHTS = {
    industry: 0.20,
    size: 0.18,
    hiring: 0.15,
    tech: 0.12,
    growth: 0.12,
    contact: 0.08,
    messageRelevance: 0.07,
    channelFit: 0.05,
    timingFit: 0.02,
    dataFreshness: 0.01
};
// Target ICP: field-service companies (civil, electrical, plumbing, landscaping, etc.)
const ICP_PRIMARY = ['civil', 'electrical', 'plumbing', 'landscaping', 'facilities', 'hvac',
    'roofing', 'painting', 'flooring', 'mechanical', 'structural', 'construction',
    'environmental', 'infrastructure', 'utility', 'utilities', 'contractor', 'contracting'];
const ICP_ADJACENT = ['maintenance', 'repair', 'service', 'installation', 'inspection',
    'cleaning', 'pest', 'security', 'fire', 'elevator', 'telecom'];
function scoreIndustry(category) {
    if (!category)
        return 0.30;
    const lower = category.toLowerCase();
    if (ICP_PRIMARY.some(k => lower.includes(k)))
        return 1.00;
    if (ICP_ADJACENT.some(k => lower.includes(k)))
        return 0.70;
    return 0.25;
}
const HIRING_KEYWORDS = ['hiring', 'now hiring', 'job opening', 'job posting', 'recruiting',
    'looking for', 'position available', 'we are growing', 'join our team', 'career opportunity'];
function scoreHiring(combined) {
    return HIRING_KEYWORDS.some(k => combined.includes(k)) ? 1.00 : 0.10;
}
const GROWTH_KEYWORDS = ['expanding', 'new contract', 'new project', 'new office', 'acquisition',
    'series a', 'series b', 'funded', 'raised', 'opening', 'growth', 'scale', 'scaling',
    'increased revenue', 'record', 'won contract', 'awarded'];
function scoreGrowth(combined) {
    const found = GROWTH_KEYWORDS.filter(k => combined.includes(k)).length;
    return Math.min(1.0, found * 0.30);
}
const HIGH_TECH_KEYWORDS = ['salesforce', 'hubspot', 'microsoft dynamics', 'sap', 'oracle',
    'servicenow', 'workday', 'zendesk', 'marketo', 'enterprise software', 'erp system'];
function scoreTech(combined) {
    // Inverse: low tech adoption = better fit for field ops software
    const isHighTech = HIGH_TECH_KEYWORDS.some(k => combined.includes(k));
    return isHighTech ? 0.25 : 1.00;
}
function scoreContact(email, contactName) {
    let score = 0;
    if (email)
        score += 0.65;
    if (contactName)
        score += 0.35;
    return Math.min(1.0, score);
}
function scoreChannelFit(email, website) {
    if (email)
        return 0.90;
    if (website)
        return 0.60;
    return 0.30;
}
function scoreDataFreshness(aiSummary) {
    return aiSummary ? 0.85 : 0.50;
}
export function computeLeadScore(lead, weights = DEFAULT_SCORING_WEIGHTS) {
    const combined = [lead.notes, lead.aiSummary, lead.outreachAngle, lead.businessName]
        .filter(Boolean).join(' ').toLowerCase();
    const signals = {
        industry: scoreIndustry(lead.category),
        size: 0.65, // default medium — unknown without enrichment
        hiring: scoreHiring(combined),
        tech: scoreTech(combined),
        growth: scoreGrowth(combined),
        contact: scoreContact(lead.email, lead.contactName),
        messageRelevance: 0.50,
        channelFit: scoreChannelFit(lead.email, lead.website),
        timingFit: 0.50,
        dataFreshness: scoreDataFreshness(lead.aiSummary)
    };
    const raw = Object.keys(weights)
        .reduce((sum, k) => sum + signals[k] * weights[k], 0);
    return Math.round(Math.min(100, Math.max(0, raw * 100)));
}
export function getScoreTier(score) {
    if (score >= 72)
        return 'HOT';
    if (score >= 48)
        return 'WARM';
    return 'COLD';
}
export const TIER_COLOR = {
    HOT: '#ef4444',
    WARM: '#f59e0b',
    COLD: '#475569'
};
