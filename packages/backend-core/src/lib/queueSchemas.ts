// Runtime validation for BullMQ job payloads. Queue payloads are an internal
// trust boundary: a stale producer, a replayed/forged job, or corrupted Redis
// state can otherwise feed a worker malformed input that it casts away with `as`
// and then writes to the DB. Each processor parses its payload before doing any
// work; an invalid payload is non-retryable (it will never become valid on retry)
// and surfaces as a clear, attributable failure rather than a confusing crash.
import { z } from 'zod'
import { UnrecoverableError } from 'bullmq'

const id = z.string().min(1)

// workspaceId is REQUIRED on lead-scoped jobs: the processor fetches the lead by
// `id + workspaceId` so a stale/replayed/forged job can never operate on a lead
// outside its tenant. Every in-code producer already passes it.
export const ResearchLeadPayloadSchema = z.object({
  leadId: id,
  workspaceId: id,
  initiatedByUserId: id.optional(),
})
export type ResearchLeadPayload = z.infer<typeof ResearchLeadPayloadSchema>

export const GenerateOutreachPayloadSchema = z.object({
  leadId: id,
  workspaceId: id,
  initiatedByUserId: id.optional(),
})
export type GenerateOutreachPayload = z.infer<typeof GenerateOutreachPayloadSchema>

export const AnalyzeReplyPayloadSchema = z.object({
  replyBody: z.string().min(1),
  leadId: id.optional(),
  workspaceId: id.optional(),
  initiatedByUserId: id.optional(),
})
export type AnalyzeReplyPayload = z.infer<typeof AnalyzeReplyPayloadSchema>

// The auto-sync scheduler enqueues `{ autoSync: true }` with no workspace; a
// targeted sync carries a workspaceId. Refined so at least one is present.
export const SyncMailboxPayloadSchema = z
  .object({
    workspaceId: id.optional(),
    autoSync: z.boolean().optional(),
    userId: id.optional(),
  })
  .refine((d) => d.autoSync === true || typeof d.workspaceId === 'string', {
    message: 'either autoSync or workspaceId is required',
  })
export type SyncMailboxPayload = z.infer<typeof SyncMailboxPayloadSchema>

export const ScoreProspectsPayloadSchema = z.object({ workspaceId: id })
export type ScoreProspectsPayload = z.infer<typeof ScoreProspectsPayloadSchema>

// Async prospect discovery. The route creates the DiscoveryRun (with the
// resolved query stored on it) and enqueues this; the worker loads the run,
// calls the provider, and imports candidates. workspaceId is carried for tenant
// validation against the loaded run.
export const DiscoverProspectsPayloadSchema = z.object({ runId: id, workspaceId: id })
export type DiscoverProspectsPayload = z.infer<typeof DiscoverProspectsPayloadSchema>

export const GenerateRecommendationsPayloadSchema = z.object({ prospectId: id, workspaceId: id })
export type GenerateRecommendationsPayload = z.infer<typeof GenerateRecommendationsPayloadSchema>

export const CalibrateScoringPayloadSchema = z.object({ workspaceId: id })
export type CalibrateScoringPayload = z.infer<typeof CalibrateScoringPayloadSchema>

export const SendCampaignPayloadSchema = z.object({
  campaignId: id,
  workspaceId: id,
  leadIds: z.array(id).optional(),
})
export type SendCampaignPayload = z.infer<typeof SendCampaignPayloadSchema>

// The retention sweep is platform-wide (no workspace) and carries no parameters;
// an empty object keeps it on the same validated-payload contract as every other
// queue so a malformed enqueue still fails fast rather than silently.
export const RetentionPurgePayloadSchema = z.object({}).passthrough()
export type RetentionPurgePayload = z.infer<typeof RetentionPurgePayloadSchema>

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ')
}

// Validate a job payload at the start of a processor. Throws BullMQ's
// UnrecoverableError on a malformed payload so the job fails immediately without
// burning retries — the worker's `failed` handler records the metric/audit event.
export function parseJobPayload<T>(schema: z.ZodType<T>, queue: string, data: unknown): T {
  const result = schema.safeParse(data)
  if (!result.success) {
    throw new UnrecoverableError(`QUEUE_PAYLOAD_INVALID: ${queue} (${formatIssues(result.error)})`)
  }
  return result.data
}
