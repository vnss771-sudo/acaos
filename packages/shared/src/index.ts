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

// ── Shared business-domain enums ─────────────────────────────────────────────
// Canonical type ownership lives here. Backend runtime code, route contracts,
// and the web UI can use these without depending on Prisma's generated enum
// exports (which are more brittle across generator/version changes).

export type WorkspaceRole = 'owner' | 'admin' | 'member'
export type BillingPlan = 'free' | 'starter' | 'growth'

export type SignalType =
  | 'HIRING'
  | 'FUNDING'
  | 'EXPANSION'
  | 'TECH_ADOPTION'
  | 'LEADERSHIP_CHANGE'
  | 'NEWS_MENTION'
  | 'PROCUREMENT'
  | 'BUSINESS_REGISTRATION'
  | 'WEBSITE_CHANGE'

export type BuyingStage = 'RESEARCHING' | 'EVALUATING' | 'COMPARING' | 'PURCHASING' | 'INACTIVE'

/** Stages a prospect outcome can be recorded at (mirror of the Prisma enum). */
export type OutcomeStage =
  | 'DISCOVERED'
  | 'VIEWED'
  | 'CONTACTED'
  | 'MEETING'
  | 'PROPOSAL'
  | 'WON'
  | 'LOST'

export type DraftStatus = 'DRAFTED' | 'APPROVED' | 'REJECTED' | 'SENT' | 'SKIPPED'
export type MissionStatus = 'DRAFT' | 'DISCOVERING' | 'REVIEWING' | 'ACTIVE' | 'PAUSED' | 'COMPLETE'
export type DiscoveryRunStatus = 'RUNNING' | 'SUCCEEDED' | 'PARTIAL' | 'FAILED'
export type SendStatus = 'PENDING' | 'SENDING' | 'SENT' | 'FAILED' | 'BOUNCED' | 'REPLIED'
export type LeadStage = 'NEW' | 'RESEARCHED' | 'OUTREACH_SENT' | 'REPLIED' | 'BOOKED' | 'CLOSED' | 'DEAD'
export type OutreachIntentStatus =
  | 'PROPOSED'
  | 'DRAFTED'
  | 'APPROVED'
  | 'QUEUED'
  | 'SENT'
  | 'WON'
  | 'LOST'
  | 'REJECTED'

// ── Auth handshake (POST /api/auth/*) ─────────────────────────────────────────
// These run in AuthScreen via raw fetch — by design: there is no bearer token
// yet, the flow must control credentials/CSRF, and a 401 means bad credentials,
// not an expired session. They can't go through the authenticated route client,
// but their bodies are still typed here for compile-time safety.
export interface LoginRequest { email: string; password: string; name?: string }
export interface ForgotPasswordRequest { email: string }
export interface ResetPasswordRequest { token: string; password: string }

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

// PATCH /api/campaigns/:id
export interface UpdateCampaignRequest {
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

// ── Route contract map ────────────────────────────────────────────────────────
// The single source of truth that binds METHOD + path → { params, query, body,
// response }. The web client calls every mutation through a typed helper keyed by
// these entries (see apps/web/src/lib/routeApi.ts), so a call can never drift from
// the contract: the path, params, body shape, and response type are all checked
// at the call site. Response types are pragmatic DTOs — only the fields the client
// reads; rich entities (Lead/Prospect/Mission/Workspace) are returned as `unknown`
// and narrowed at the call site until their DTOs are consolidated into shared.

/** Minimal campaign shape returned by create/update. */
export interface CampaignDTO {
  id: string
  name: string
  goalType: string
  description?: string | null
  createdAt: string
  _count?: { leads: number }
}

// ── Additional mutation request bodies (frontend → API) ───────────────────────
// Partial lead update. Nullable string fields mirror the Lead columns so the web
// edit form (which PATCHes a spread of the whole Lead) is assignable; the backend
// ignores nulls and updates only the strings present.
export interface UpdateLeadRequest {
  businessName?: string
  contactName?: string | null
  email?: string | null
  website?: string | null
  city?: string | null
  category?: string | null
  notes?: string | null
  aiSummary?: string | null
  outreachAngle?: string | null
  stage?: string
  campaignId?: string | null
  score?: number
  phone?: string | null
  lastContactedAt?: string | null
  id?: string
  createdAt?: string
}
export interface BulkLeadIdsRequest { workspaceId: string; ids: string[] }
export interface BulkLeadStageRequest { workspaceId: string; ids: string[]; stage: string }
/** Body for the async job-enqueue endpoints (POST /api/jobs/:type). */
export interface JobEnqueueRequest {
  leadId?: string
  workspaceId?: string
  replyBody?: string
  businessName?: string
  website?: string
  category?: string
  city?: string
  contactName?: string
  aiSummary?: string
  outreachAngle?: string
  notes?: string
}
export interface CreateSignalRequest {
  workspaceId: string
  prospectId: string
  type: string
  strength: number
  title?: string
  description?: string
  sourceUrl?: string
  source?: string
  sourceReliability?: number
  industryRelevance?: number
  // Accepts an ISO string or an epoch number; the API coerces via new Date().
  detectedAt?: string | number
}
// The web create form spreads its prospect draft, whose columns are nullable, so
// the declared fields accept null (undeclared form fields are dropped by the
// spread and ignored by the backend).
export interface CreateProspectRequest {
  workspaceId: string
  companyName?: string | null
  domain?: string | null
  industry?: string | null
  employeeCount?: number | null
  location?: string | null
  contactName?: string | null
  contactEmail?: string | null
  contactTitle?: string | null
}
export interface ImportProspectsRequest {
  workspaceId: string
  rows: Record<string, unknown>[]
}
export interface BillingCheckoutRequest { workspaceId: string; plan: 'starter' | 'growth' }
export interface BillingPortalRequest { workspaceId: string }
export interface UpdateWorkspaceRequest {
  name?: string
  slug?: string
  senderBusinessName?: string | null
  senderPostalAddress?: string | null
}
export interface WorkspaceMemberInviteRequest { email: string; role: string }
export interface EmailConfigRequest {
  smtpHost?: string | null
  smtpPort?: number | null
  smtpSecure?: boolean
  smtpUser?: string | null
  smtpPass?: string | null
  smtpFrom?: string | null
  imapHost?: string | null
  imapPort?: number | null
  imapSecure?: boolean
  imapUser?: string | null
  imapPass?: string | null
}
export interface ProfileUpdateRequest {
  name?: string | null
  currentPassword?: string
  newPassword?: string
}
export interface ApplyPackRequest { workspaceId: string }

export interface RouteContracts {
  // Campaigns
  'POST /api/campaigns': { body: CreateCampaignRequest; response: { campaign: CampaignDTO } }
  'PATCH /api/campaigns/:id': { params: { id: string }; body: UpdateCampaignRequest; response: { campaign: CampaignDTO } }
  'DELETE /api/campaigns/:id': { params: { id: string }; response: { ok: boolean } }
  'POST /api/campaigns/:id/send': { params: { id: string }; body: SendCampaignRequest; response: { jobId: string; eligible: number; message: string } }
  'POST /api/campaigns/:id/retry-failed': { params: { id: string }; response: { cleared: number } }

  // AI tools (sync)
  'POST /api/ai/research': { body: AiResearchRequest; response: { result: string } }
  'POST /api/ai/outreach': { body: AiOutreachRequest; response: { result: string } }
  'POST /api/ai/reply-analysis': { body: AiReplyAnalysisRequest; response: { result: unknown } }

  // Async jobs
  'POST /api/jobs/events/ticket': { response: { ticket: string } }
  'POST /api/jobs/:type': { params: { type: string }; body: JobEnqueueRequest; response: { jobId: string; queue: string } }

  // Leads
  'POST /api/leads': { body: CreateLeadRequest; response: unknown }
  'PATCH /api/leads/:id': { params: { id: string }; body: UpdateLeadRequest; response: unknown }
  'DELETE /api/leads/:id': { params: { id: string }; response: unknown }
  'POST /api/leads/import': { body: ImportLeadsRequest; response: { created: number } }
  'POST /api/leads/bulk-delete': { body: BulkLeadIdsRequest; response: { deleted: number } }
  'POST /api/leads/bulk-stage': { body: BulkLeadStageRequest; response: { updated: number } }

  // Approval-queue drafts (lead-scoped)
  'PATCH /api/leads/:id/drafts/:draftId': { params: { id: string; draftId: string }; body: UpdateDraftRequest; response: unknown }
  'POST /api/leads/:id/drafts/:draftId/:action': { params: { id: string; draftId: string; action: string }; response: unknown }

  // Prospects
  'POST /api/prospects': { body: CreateProspectRequest; response: unknown }
  'POST /api/prospects/discover': { body: DiscoverProspectsRequest; response: { discovered: number; skipped: number; total: number } }
  'POST /api/prospects/import': { body: ImportProspectsRequest; response: { imported: number; skipped: number; failed: number; errors: string[] } }
  'POST /api/prospects/:id/rescore': { params: { id: string }; response: unknown }
  'POST /api/prospects/:id/recommend': { params: { id: string }; response: unknown }
  'POST /api/prospects/:id/enrich': { params: { id: string }; response: { signalsCreated: number } }
  'POST /api/prospects/:id/outcome': { params: { id: string }; body: RecordProspectOutcomeRequest; response: unknown }
  'POST /api/prospects/:prospectId/intents/:intentId/:action': { params: { prospectId: string; intentId: string; action: string }; response: unknown }

  // Signals
  'POST /api/signals': { body: CreateSignalRequest; response: unknown }

  // Missions
  'POST /api/missions': { body: CreateMissionRequest; response: unknown }
  'PATCH /api/missions/:id': { params: { id: string }; body: UpdateMissionRequest; response: unknown }
  'POST /api/missions/:id/score': { params: { id: string }; response: unknown }

  // Workspaces
  'PATCH /api/workspaces/:id': { params: { id: string }; body: UpdateWorkspaceRequest; response: unknown }
  'PUT /api/workspaces/:id/icp': { params: { id: string }; body: UpdateIcpRequest; response: unknown }
  'POST /api/workspaces/:id/seed': { params: { id: string }; body: SeedWorkspaceRequest; response: unknown }
  'PUT /api/workspaces/:id/email-config': { params: { id: string }; body: EmailConfigRequest; response: unknown }
  'POST /api/workspaces/:id/members': { params: { id: string }; body: WorkspaceMemberInviteRequest; response: unknown }
  'DELETE /api/workspaces/:id/members/:userId': { params: { id: string; userId: string }; response: unknown }
  'POST /api/workspaces/:id/invites': { params: { id: string }; body: WorkspaceMemberInviteRequest; response: unknown }
  'DELETE /api/workspaces/:id/invites/:inviteId': { params: { id: string; inviteId: string }; response: unknown }
  'POST /api/workspaces/:id/api-key/rotate': { params: { id: string }; response: { apiKey: string } }
  'DELETE /api/workspaces/:id/api-key': { params: { id: string }; response: unknown }

  // Billing
  'POST /api/billing/checkout': { body: BillingCheckoutRequest; response: { url: string } }
  'POST /api/billing/portal': { body: BillingPortalRequest; response: { url: string } }

  // Auth profile / misc
  'PATCH /api/auth/profile': { body: ProfileUpdateRequest; response: unknown }
  'POST /api/auth/resend-verification': { response: unknown }
  'POST /api/packs/fieldops/apply': { body: ApplyPackRequest; response: unknown }
}

export type RouteKey = keyof RouteContracts
export type RouteParams<K extends RouteKey> = RouteContracts[K] extends { params: infer P } ? P : undefined
export type RouteBody<K extends RouteKey> = RouteContracts[K] extends { body: infer B } ? B : undefined
export type RouteResponse<K extends RouteKey> = RouteContracts[K] extends { response: infer R } ? R : unknown
