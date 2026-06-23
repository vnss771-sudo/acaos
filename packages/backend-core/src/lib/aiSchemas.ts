// Schema-constrained validation for every AI (OpenAI) output that drives an
// automated workflow or a database write. The model is asked for JSON, but JSON
// mode alone does not guarantee shape — a drifting or truncated response could
// silently weaken scoring, draft quality, or reply classification. These schemas
// are the trust boundary between the model and the rest of the system.
//
// Two parsing disciplines, chosen per workflow:
//   • parseAiJson()        — STRICT, fails closed (throws AiSchemaError). Used
//                            where the output is persisted or branches automation
//                            (outreach drafts, reply classification). Better to
//                            retry/refund than to write garbage.
//   • parseLeadResearchJson() — LENIENT. Research is best-effort enrichment, so a
//                            malformed field is dropped rather than failing the
//                            whole job; the scorer falls back to its computed score.
import { z } from 'zod'
import { ApiError } from './errors.js'

// ── Reply classification ──────────────────────────────────────────────────────
// These six values drive CRM stage transitions and lead scoring, so the model is
// constrained to exactly this set — an unknown value must fail, not silently no-op.
export const REPLY_CLASSIFICATIONS = [
  'INTERESTED',
  'NOT_INTERESTED',
  'NEEDS_MORE_INFO',
  'NOT_NOW',
  'OUT_OF_OFFICE',
  'REFERRAL',
] as const

export const REPLY_URGENCIES = ['immediate', 'this_week', 'this_month', 'nurture', 'never'] as const

export const DIGITAL_MATURITY = ['low', 'medium', 'high'] as const
export const TEAM_SIZE_BUCKETS = ['1-10', '10-50', '50-200', '200-500', '500+'] as const

// Evidence strength is about PROVENANCE, not the model's self-rated certainty:
//   confirmed = backed by a concrete source the model was actually given (a URL)
//   observed  = appears in the provided text/notes, but no canonical source link
//   inferred  = the model's own hypothesis — the weakest tier
// `inferred` is also the safe DEFAULT (see EvidenceItemSchema): a drifting `type`
// degrades to a hypothesis rather than being trusted as fact, so an LLM guess can
// never silently masquerade as a confirmed datum.
export const EVIDENCE_TYPES = ['confirmed', 'observed', 'inferred'] as const
export const CONFIDENCE_LEVELS = ['low', 'medium', 'high'] as const
// What a human/automation should do next with this lead. `auto_draft` is only
// appropriate when the fit is strong and the evidence is mostly confirmed/observed.
export const RECOMMENDED_ACTIONS = ['auto_draft', 'manual_review_then_draft', 'skip'] as const

// One piece of evidence behind the assessment. `signal` (the actual observation)
// is required; `type`/`confidence` self-heal to the weakest value so a single
// drifting field never discards the observation itself.
export const EvidenceItemSchema = z.object({
  signal: z.string().min(1).max(500),
  type: z.enum(EVIDENCE_TYPES).catch('inferred'),
  confidence: z.enum(CONFIDENCE_LEVELS).catch('low'),
  sourceUrl: z.string().max(2000).optional().catch(undefined),
})
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>

// Parse an evidence array item-by-item so one malformed entry is dropped, not the
// whole list — consistent with the lenient, best-effort research discipline.
const EvidenceArrayField = z.preprocess(
  (raw) => {
    if (!Array.isArray(raw)) return undefined
    const items: EvidenceItem[] = []
    for (const entry of raw) {
      if (items.length >= 20) break
      const parsed = EvidenceItemSchema.safeParse(entry)
      if (parsed.success) items.push(parsed.data)
    }
    return items
  },
  z.array(EvidenceItemSchema).optional(),
).catch(undefined)

// ── Lead research (lenient) ─────────────────────────────────────────────────────
// Every field is optional and self-healing (.catch drops a wrong-typed value)
// because research only enriches a lead — partial intelligence is still useful and
// must never block the pipeline. Strictness here would trade resilience for nothing.
export const LeadResearchOutputSchema = z.object({
  aiSummary: z.string().max(4000).optional().catch(undefined),
  outreachAngle: z.string().max(1000).optional().catch(undefined),
  // Legacy free-text signals; superseded by `evidence` but still parsed so older
  // prompts/responses keep working.
  qualificationSignals: z.array(z.string().max(500)).max(20).optional().catch(undefined),
  // Structured, provenance-labelled evidence behind the assessment.
  evidence: EvidenceArrayField,
  // Plain-language caveats a human should know before trusting the assessment
  // (e.g. "team size is estimated, not confirmed").
  riskFlags: z.array(z.string().max(300)).max(10).optional().catch(undefined),
  // Suggested next step, and overall confidence in the assessment as a whole.
  recommendedAction: z.enum(RECOMMENDED_ACTIONS).optional().catch(undefined),
  confidence: z.enum(CONFIDENCE_LEVELS).optional().catch(undefined),
  icpScore: z.number().min(0).max(100).optional().catch(undefined),
  hiringSignals: z.boolean().optional().catch(undefined),
  digitalMaturity: z.enum(DIGITAL_MATURITY).optional().catch(undefined),
  estimatedTeamSize: z.enum(TEAM_SIZE_BUCKETS).optional().catch(undefined),
})
export type LeadResearchOutput = z.infer<typeof LeadResearchOutputSchema>

// ── Outreach draft (strict) ─────────────────────────────────────────────────────
// subject + email are required and persisted, so a draft missing either is
// unusable and must fail closed. Length caps bound a runaway model response.
export const OutreachDraftOutputSchema = z.object({
  subject: z.string().min(1).max(500),
  email: z.string().min(1).max(8000),
  followup: z.string().max(8000).optional(),
})
export type OutreachDraftOutput = z.infer<typeof OutreachDraftOutputSchema>

// ── Reply analysis (strict) ─────────────────────────────────────────────────────
export const ReplyAnalysisOutputSchema = z.object({
  classification: z.enum(REPLY_CLASSIFICATIONS),
  confidence: z.number().min(0).max(100).optional(),
  summary: z.string().max(2000).optional(),
  suggestedAction: z.string().max(2000).optional(),
  urgency: z.enum(REPLY_URGENCIES).optional(),
  keyQuote: z.string().max(1000).optional(),
  isAutoReply: z.boolean().optional(),
})
export type ReplyAnalysisOutput = z.infer<typeof ReplyAnalysisOutputSchema>

// Typed, fail-closed error for AI output that does not match its schema. Extends
// ApiError so it maps to a 502 in the Express layer and is distinguishable from a
// transport/circuit error by callers and by metrics/audit.
export class AiSchemaError extends ApiError {
  readonly operation: string
  readonly issues: string
  constructor(operation: string, issues: string) {
    super(502, `AI_SCHEMA_INVALID: ${operation} (${issues})`)
    this.name = 'AiSchemaError'
    this.operation = operation
    this.issues = issues
  }
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ')
}

// Strict parse: JSON-decode then Zod-validate, throwing AiSchemaError on any
// failure. `operation` labels the error so logs/metrics can attribute the failure.
export function parseAiJson<T>(schema: z.ZodType<T>, raw: string, operation: string): T {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new AiSchemaError(operation, 'response was not valid JSON')
  }
  const result = schema.safeParse(json)
  if (!result.success) {
    throw new AiSchemaError(operation, formatIssues(result.error))
  }
  return result.data
}

// Lenient parse for lead research: never throws. Non-JSON or non-object input
// degrades to an empty result; individual wrong-typed fields are dropped by the
// schema's per-field .catch. Callers treat every field as optional.
export function parseLeadResearchJson(raw: string): LeadResearchOutput {
  let json: unknown = {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) json = parsed
  } catch {
    /* tolerate — research is best-effort enrichment, not an automation branch */
  }
  return LeadResearchOutputSchema.parse(json)
}
