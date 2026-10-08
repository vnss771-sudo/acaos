// Domain processor barrel. Implementations live in ./processors/* so worker.ts
// can stay stable while processor domains evolve independently.
export { scoreProspects, calibrateScoring } from './processors/scoring.js'
export { researchLead, generateOutreachDraft } from './processors/outreach.js'
export { sendCampaignBatch, resolveDraftSource, isUniqueConstraintViolation, collectDraftViolations } from './processors/campaignSend.js'
export type { SendSkipReason, DraftSourceDecision } from './processors/campaignSend.js'
export { sendFollowupTask } from './processors/followups.js'
export type { SendFollowupStatus, SendFollowupResult } from './processors/followups.js'
export { discoverProspectsBatch } from './processors/discovery.js'
export type { DiscoverProspectsResult } from './processors/discovery.js'
export { applyReplyAnalysis } from './processors/replies.js'
