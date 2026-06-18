// ── Shared API contract ───────────────────────────────────────────────────────
// Single source of truth for the shape of mutation request bodies exchanged
// between the web client and the API. Both sides import these TYPES (type-only,
// so there is zero runtime dependency and no build-order coupling).
//
// Why this exists: two production bugs shipped under a fully green test suite
// because the frontend omitted a field the backend required — the route tests
// build their own request bodies, so they never caught the omission. With these
// contracts, a missing required field (e.g. `workspaceId`, `approved`) is a
// COMPILE error at the call site, not a 400/403 a user discovers in production.
//
// Convention: every required field here is one the backend rejects the request
// without. Optional fields mirror the backend's optional handling.

// ── Compile-time conformance helpers ─────────────────────────────────────────
// Used on the backend to prove a runtime validation schema (e.g. a zod schema)
// produces exactly the contract the frontend is typed against. If the two drift,
// the build fails — the contract can never silently diverge from validation.
export type Assert<T extends true> = T
export type Extends<A, B> = A extends B ? true : false

/** Stages a prospect outcome can be recorded at (mirror of the Prisma enum). */
export type OutcomeStage =
  | 'DISCOVERED'
  | 'CONTACTED'
  | 'MEETING'
  | 'PROPOSAL'
  | 'WON'
  | 'LOST'

// ── AI tools (POST /api/ai/*) ────────────────────────────────────────────────
// Every handler rejects the request with 400 "workspaceId required" before doing
// any work, so workspaceId is required here.
export interface AiResearchRequest {
  workspaceId: string
  businessName: string
  website?: string
  category?: string
  city?: string
  notes?: string
}

export interface AiOutreachRequest {
  workspaceId: string
  businessName: string
  category?: string
  city?: string
  contactName?: string
  aiSummary?: string
  outreachAngle?: string
  notes?: string
}

export interface AiReplyAnalysisRequest {
  workspaceId: string
  replyBody: string
}

// ── Campaigns ─────────────────────────────────────────────────────────────────
export interface CreateCampaignRequest {
  workspaceId: string
  name: string
  goalType: string
  description?: string
}

// POST /api/campaigns/:id/send. `approved` is mandatory in the contract even
// though the backend only enforces it under approvalMode: approvalMode is the
// DEFAULT for onboarded workspaces, and always sending the flag is harmless
// otherwise. Requiring it here makes "launch without approval" impossible to ship.
export interface SendCampaignRequest {
  approved: boolean
  leadIds?: string[]
}

// ── Leads ─────────────────────────────────────────────────────────────────────
export interface LeadInput {
  businessName: string
  campaignId?: string | null
  contactName?: string
  email?: string
  website?: string
  city?: string
  category?: string
  notes?: string
  sourceTag?: string
}

export interface CreateLeadRequest extends LeadInput {
  workspaceId: string
}

export interface ImportLeadsRequest {
  workspaceId: string
  leads: LeadInput[]
}

// ── Prospects ─────────────────────────────────────────────────────────────────
// POST /api/prospects/:id/outcome — the prospect (and thus workspace) comes from
// the URL; only the outcome stage is required.
export interface RecordProspectOutcomeRequest {
  stage: OutcomeStage
  notes?: string
  dealValue?: number
}

// POST /api/prospects/discover — pull companies from a discovery source. The
// query defaults from the workspace ICP (and, when scoped to a mission, that
// mission's playbook preset); explicit fields here override those defaults.
export interface DiscoverProspectsRequest {
  workspaceId: string
  source?: string
  missionId?: string | null
  industries?: string[]
  locations?: string[]
  keywords?: string[]
  minEmployees?: number
  maxEmployees?: number
  limit?: number
}

// ── Workspaces ────────────────────────────────────────────────────────────────
// PUT /api/workspaces/:id/icp
export interface UpdateIcpRequest {
  businessType?: string | null
  playbook?: string | null
  targetIndustries: string[]
  targetGeos: string[]
  minEmployees?: number | null
  maxEmployees?: number | null
  mustHaveEmail?: boolean
  outreachTone?: string
  dailySendLimit?: number
  approvalMode?: boolean
  excludedIndustries?: string[]
}

// POST /api/workspaces/:id/seed
export interface SeedWorkspaceRequest {
  playbookId: string | null
  includeExamples: boolean
}

// ── Missions ──────────────────────────────────────────────────────────────────
export type MissionStatus = 'DRAFT' | 'DISCOVERING' | 'REVIEWING' | 'ACTIVE' | 'PAUSED' | 'COMPLETE'

// POST /api/missions — creates a Mission and its linked execution Campaign.
export interface CreateMissionRequest {
  workspaceId: string
  name: string
  goalType: string
  targetCustomer?: string
  offer?: string
  playbookId?: string | null
}

// PATCH /api/missions/:id
export interface UpdateMissionRequest {
  name?: string
  status?: MissionStatus
}

// ── Approval queue / drafts ───────────────────────────────────────────────────
// PATCH /api/leads/:id/drafts/:draftId — reviewer edits copy before approving.
export interface UpdateDraftRequest {
  subject?: string
  emailBody?: string
  followup?: string | null
}
