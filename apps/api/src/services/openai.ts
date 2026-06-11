import OpenAI from 'openai'
import { ApiError } from '../lib/http.js'
import { hasEnv } from '../lib/env.js'
import type { ScoreEvidence } from '../lib/signalEngine.js'

export type ProductContext = {
  productName:     string
  productCategory?: string | null
  targetICP?:       string | null
  keyPainPoints:   string[]
  differentiators: string[]
  ctaType:         string
  calendarUrl?:    string | null
}

const DEFAULT_PRODUCT: ProductContext = {
  productName:     'field operations software',
  productCategory: 'FSM',
  targetICP:       'trades and field-service businesses (civil engineering, electrical, plumbing, HVAC, landscaping, construction) with 10–500 employees that rely on mobile field teams',
  keyPainPoints:   ['scheduling', 'dispatching', 'quoting', 'job costing', 'invoicing', 'crew coordination'],
  differentiators: ['mobile-first', 'easy onboarding', 'purpose-built for field teams'],
  ctaType:         'book_call',
  calendarUrl:     null,
}

import { cfg } from '../lib/env.js'

function getOpenAiClient() {
  if (!hasEnv(['OPENAI_API_KEY'])) throw new ApiError(503, 'OpenAI is not configured')
  return new OpenAI({ apiKey: cfg.openaiApiKey! })
}

function model() {
  return cfg.openaiModel
}

async function chat(system: string, user: string): Promise<string> {
  const client = getOpenAiClient()
  const completion = await client.chat.completions.create({
    model: model(),
    response_format: { type: 'json_object' },
    temperature: 0.4,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]
  })
  return completion.choices[0]?.message?.content ?? '{}'
}

export async function generateLeadResearch(input: {
  businessName: string
  website?: string
  category?: string
  city?: string
  notes?: string
  product?: ProductContext
}): Promise<string> {
  const p = input.product ?? DEFAULT_PRODUCT
  const pains = p.keyPainPoints.join(', ')
  return chat(
    `You are an expert B2B sales intelligence analyst. Your job: produce actionable sales intelligence for a cold outreach campaign selling ${p.productName} (${pains}).

Target ICP: ${p.targetICP ?? 'businesses that would benefit from ' + p.productName}

Return ONLY a valid JSON object with these exact keys:
- aiSummary (string): 2–3 sentences. Describe the business, its likely operational pain points, and why they are a strong or weak fit for ${p.productName}. Be concrete.
- outreachAngle (string): The single strongest personalised hook for a cold email opener — under 20 words. Must reference something specific about their business, NOT a generic benefit.
- qualificationSignals (string[]): 3–5 specific signals extracted from available info.
- icpScore (number): 0–100. How closely this prospect matches the ICP. Deduct for enterprises with existing solutions, very small companies, or poor fit.
- hiringSignals (boolean): true if any evidence suggests they are currently hiring or expanding.
- digitalMaturity ("low" | "medium" | "high"): Low = spreadsheets/paper, Medium = generic software, High = dedicated solution already in place.
- estimatedTeamSize ("1-10" | "10-50" | "50-200" | "200-500" | "500+"): Best estimate from all available signals.`,

    `Analyse this prospect for B2B cold outreach:

Business name: ${input.businessName}
Industry / category: ${input.category || 'Not specified'}
City / region: ${input.city || 'Not specified'}
Website: ${input.website || 'Not provided'}
Additional notes: ${input.notes || 'None'}

Key question to answer: Are they large enough to have real problems but small enough that they haven't already solved them with an enterprise solution?`
  )
}

export async function generateOutreach(input: {
  businessName: string
  category?: string
  city?: string
  contactName?: string
  aiSummary?: string
  outreachAngle?: string
  product?: ProductContext
}): Promise<string> {
  const firstName = input.contactName?.split(' ')[0] ?? null
  const p = input.product ?? DEFAULT_PRODUCT

  const ctaLine = p.ctaType === 'book_call' && p.calendarUrl
    ? `End with a calendar link CTA: "${p.calendarUrl}"`
    : p.ctaType === 'demo'
      ? `Ask if they'd like to see a quick demo`
      : p.ctaType === 'free_trial'
        ? `Ask if they'd like to try it free for 14 days`
        : `End with a simple yes/no question`

  return chat(
    `You are an elite B2B cold email copywriter selling ${p.productName}.

Your emails achieve 15–30% reply rates because they:
1. Reference something specific about the recipient's actual business
2. Stay under 90 words in the body (brevity is respect)
3. Open with a crisp observation — never "I hope this email finds you well"
4. Make ONE clear ask. ${ctaLine}
5. Sound like a thoughtful human, not a marketing department

Return ONLY a valid JSON object:
- subject (string): Under 8 words. Specific, not generic.
- email (string): Body only, no subject/sign-off. Under 90 words.
- followup (string): 2-sentence follow-up for 4–5 days later. Ends with a question.`,

    `Write a cold outreach email:

Business: ${input.businessName}
Industry: ${input.category || 'their sector'}
Location: ${input.city || 'their area'}
${firstName ? `Contact: ${firstName}` : ''}
Research: ${input.aiSummary || `A company that could benefit from ${p.productName}`}
Hook: ${input.outreachAngle || `helping them with ${p.keyPainPoints[0] ?? 'operations'}`}

Write it for ${input.businessName} specifically, not from a template.`
  )
}

export async function generateSignalAwareOutreach(input: {
  businessName: string
  category?: string
  city?: string
  contactName?: string
  aiSummary?: string
  outreachAngle?: string
  signals: Array<{ type: string; title?: string | null; description?: string | null; strength: number }>
  buyingStage?: string
  opportunityScore?: number
  poaActivated?: boolean
  poaTier?: string
  templateType?: 'INITIAL' | 'FOLLOWUP_1' | 'FOLLOWUP_2'
  product?: ProductContext
}): Promise<string> {
  const firstName    = input.contactName?.split(' ')[0] ?? null
  const templateType = input.templateType ?? 'INITIAL'
  const p            = input.product ?? DEFAULT_PRODUCT

  const topSignals = input.signals
    .filter(s => s.type !== 'PROBLEM_OWNER_ACTIVATION')
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 5)

  const signalContext = topSignals.length > 0
    ? topSignals.map(s => {
        const label = s.title ?? s.type.replace(/_/g, ' ')
        return s.description ? `• ${label}: ${s.description}` : `• ${label} (strength ${s.strength})`
      }).join('\n')
    : 'No specific signals detected yet'

  const urgencyNote = input.poaActivated
    ? `⚡ CRITICAL: This prospect has ${input.poaTier ?? 'CONFIRMED'} Problem-Owner Activation — open buying window. Reference the specific trigger in your opening line.`
    : ''

  const ctaSuffix = templateType !== 'FOLLOWUP_2' && p.ctaType === 'book_call' && p.calendarUrl
    ? ` If they say yes, offer: ${p.calendarUrl}`
    : ''

  const templateGuide =
    templateType === 'INITIAL'
      ? `Write a first-touch cold email. Open with a specific observation from the signals. Under 90 words. One clear CTA.${ctaSuffix}`
      : templateType === 'FOLLOWUP_1'
        ? `Write a follow-up (4–5 days after first). Acknowledge first email briefly. Different angle. Under 60 words. Ends with a question.`
        : 'Write a short breakup email. Last message. Give them an easy out. Under 40 words.'

  return chat(
    `You are an elite B2B cold email copywriter selling ${p.productName}.

Rules:
1. Reference SPECIFIC evidence from the prospect's actual recent signals — never generic platitudes
2. Sound like a thoughtful human, not a marketing department
3. Every word earns its place

${urgencyNote}

Return ONLY a valid JSON object:
- subject (string): Under 8 words. Specific, feels like a peer forwarding something.
- email (string): Body only. No subject, no sign-off.
- followup (string): 2-sentence follow-up. Different angle. Ends with a question.`,

    `Write a ${templateType.replace('_', ' ').toLowerCase()} email for:

Business: ${input.businessName}
Industry: ${input.category || 'their sector'}
Location: ${input.city || 'their area'}
${firstName ? `Contact: ${firstName}` : ''}
Stage: ${input.buyingStage || 'RESEARCHING'} | Score: ${input.opportunityScore ?? 0}/100
Research: ${input.aiSummary || `Company that could benefit from ${p.productName}`}
Hook: ${input.outreachAngle || `helping with ${p.keyPainPoints[0] ?? 'operations'}`}

LIVE SIGNALS (real intelligence — use at least one):
${signalContext}

${templateGuide}`
  )
}

export type OpportunityBriefInput = {
  companyName:    string
  industry:       string | null
  location:       string | null
  employeeCount:  number | null
  contactTitle:   string | null
  buyingStage:    string
  opportunityScore: number
  signals: Array<{
    type:        string
    title:       string | null
    description: string | null
    strength:    number
    ageDays:     number
  }>
  evidence:  ScoreEvidence
  product:   ProductContext | null
}

export type OpportunityBriefOutput = {
  buyingWindowStrength: 'HIGH' | 'MEDIUM' | 'LOW'
  whyNow:           string[]   // 3-5 signal-derived bullets
  likelyProblem:    string     // one-sentence operational pain
  problemOwnerRole: string     // job title who owns this problem
  offerAngle:       string     // one-sentence offer framing
  outreachApproach: string     // tone/style guidance
  confidenceScore:  number     // 0-100
}

export async function generateOpportunityBrief(input: OpportunityBriefInput): Promise<OpportunityBriefOutput> {
  const p = input.product ?? DEFAULT_PRODUCT

  const topSignals = input.signals
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 5)
    .map(s => {
      const label = s.title ?? s.type.replace(/_/g, ' ')
      const desc = s.description ? ` — ${s.description}` : ''
      return `• [${s.type}] ${label}${desc} (strength ${s.strength}, ${s.ageDays}d ago)`
    }).join('\n')

  const { fitBreakdown, timingBreakdown, confidenceBreakdown, rejectionReasons } = input.evidence

  const evidenceSummary = [
    `Fit: industry=${fitBreakdown.industryMatch}, size=${fitBreakdown.sizeInRange}, email=${fitBreakdown.hasEmail}, score=${fitBreakdown.score}`,
    `Timing: most-recent-signal=${timingBreakdown.mostRecentAgeDays}d ago, score=${timingBreakdown.score}`,
    `Confidence: signals=${confidenceBreakdown.signalCount}, avg-reliability=${confidenceBreakdown.avgReliability}, score=${confidenceBreakdown.score}`,
  ].join('\n')

  const rejectionSummary = rejectionReasons.length > 0
    ? `Weak/rejected signals:\n${rejectionReasons.map(r => `• ${r}`).join('\n')}`
    : 'No rejected signals.'

  const productContext = p
    ? `Product: ${p.productName} (${p.productCategory ?? 'SaaS'})
ICP: ${p.targetICP ?? 'businesses that need ' + p.productName}
Pain points: ${p.keyPainPoints.join(', ')}
Differentiators: ${p.differentiators.join(', ')}`
    : 'Product context not available.'

  const raw = await chat(
    `You are a B2B sales intelligence analyst. Given company signals and scoring context, answer five questions: why this company, why now, what is the likely problem, who owns it, and what offer angle is most likely to land. Be specific to the signals provided — never generic.

Return ONLY a valid JSON object with these exact keys:
- buyingWindowStrength ("HIGH" | "MEDIUM" | "LOW"): Overall buying window strength. HIGH = multiple recent strong signals, MEDIUM = some signals, LOW = weak or old signals.
- whyNow (string[]): 3–5 concise bullets, each derived from a specific signal. Start each with the signal type in brackets, e.g. "[JOB_POSTING]".
- likelyProblem (string): One sentence. The operational pain this company most likely has right now, inferred from signals.
- problemOwnerRole (string): Job title or role who owns this problem (the person to reach). Be specific: "Head of Field Operations", not "Manager".
- offerAngle (string): One sentence. How to frame the offer specifically for this company's situation. Must reference the inferred problem.
- outreachApproach (string): Tone and style guidance for the outreach message — e.g. "Lead with the hiring signal, peer-to-peer tone, no jargon, ask a yes/no question".
- confidenceScore (number): 0–100. Your confidence in this brief. Deduct for few signals, old signals, low reliability, or poor ICP fit.`,

    `Analyse this prospect for a targeted B2B opportunity brief:

Company: ${input.companyName}
Industry: ${input.industry ?? 'Unknown'}
Location: ${input.location ?? 'Unknown'}
Employees: ${input.employeeCount ?? 'Unknown'}
Contact title: ${input.contactTitle ?? 'Unknown'}
Buying stage: ${input.buyingStage}
Opportunity score: ${input.opportunityScore}/100

TOP SIGNALS:
${topSignals || 'No signals available'}

SCORE EVIDENCE:
${evidenceSummary}

${rejectionSummary}

${productContext}

Answer the five questions with evidence-based specificity. If signals are sparse, reflect that in a lower confidenceScore.`
  )

  let parsed: OpportunityBriefOutput
  try {
    parsed = JSON.parse(raw) as OpportunityBriefOutput
  } catch {
    throw new ApiError(500, 'Failed to parse opportunity brief from AI response')
  }

  // Normalise and clamp
  const validStrengths = ['HIGH', 'MEDIUM', 'LOW']
  if (!validStrengths.includes(parsed.buyingWindowStrength)) {
    parsed.buyingWindowStrength = input.opportunityScore >= 70 ? 'HIGH' : input.opportunityScore >= 40 ? 'MEDIUM' : 'LOW'
  }
  if (!Array.isArray(parsed.whyNow) || parsed.whyNow.length === 0) parsed.whyNow = ['No specific signals available']
  parsed.confidenceScore = Math.max(0, Math.min(100, Math.round(parsed.confidenceScore ?? 50)))

  return parsed
}

export async function prospectGuidedChat(
  context: {
    companyName: string
    industry: string | null
    brief: {
      whyNow: string[]
      likelyProblem: string
      problemOwnerRole: string
      offerAngle: string
    } | null
    product: ProductContext | null
  },
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
): Promise<string> {
  const p = context.product ?? DEFAULT_PRODUCT
  const systemPrompt = `You are an intelligent assistant helping ${context.companyName}${context.industry ? ` (${context.industry})` : ''} understand how ${p.productName} can solve their specific problems.

${context.brief ? `What we know about their situation:
- Likely operational problem: ${context.brief.likelyProblem}
- Who typically owns this problem: ${context.brief.problemOwnerRole}
- Why now: ${context.brief.whyNow.slice(0, 3).join('; ')}
- Recommended approach: ${context.brief.offerAngle}` : ''}

${p.keyPainPoints.length > 0 ? `Key pain points ${p.productName} solves: ${p.keyPainPoints.join(', ')}.` : ''}
${p.differentiators.length > 0 ? `What makes it different: ${p.differentiators.join(', ')}.` : ''}

Rules:
- Be conversational, honest, and specific to their context.
- Never be pushy or use sales clichés.
- Keep replies to 1–3 sentences unless a longer answer is genuinely needed.
- If you don't know something, say so rather than making it up.`

  const client = getOpenAiClient()
  const completion = await client.chat.completions.create({
    model: model(),
    temperature: 0.6,
    messages: [{ role: 'system', content: systemPrompt }, ...messages],
  })
  return completion.choices[0]?.message?.content ?? "I'm not sure how to answer that — please feel free to reach out directly."
}

export async function analyzeReply(replyBody: string): Promise<string> {
  return chat(
    `You are a B2B sales intelligence system that classifies cold email replies for field-service software sales teams.

Your classifications drive automated workflows (CRM stage updates, follow-up triggers, lead scoring adjustments), so accuracy matters more than speed.

Nuances to handle correctly:
- "Let me pass this along" = REFERRAL (not INTERESTED)
- "Not right now but check back in Q2" = NOT_NOW (not NOT_INTERESTED)
- "Can you send more info?" = NEEDS_MORE_INFO
- Auto-reply or out-of-office = OUT_OF_OFFICE
- "We already have something" = NOT_INTERESTED
- Calendar links, "happy to chat" = INTERESTED

Return ONLY a valid JSON object with these exact keys:
- classification (string): Exactly one of: INTERESTED | NOT_INTERESTED | NEEDS_MORE_INFO | NOT_NOW | OUT_OF_OFFICE | REFERRAL
- confidence (number): 0–100. Your confidence in the classification.
- summary (string): One sentence — what they said and their actual intent.
- suggestedAction (string): Specific next step. E.g. "Reply within 24h and propose a 20-min call for [day range]", "Mark dead and add to 6-month re-engagement sequence", "Send the one-pager and ask which of the three use cases resonates most", "Contact the referred person: [name if mentioned]".
- urgency ("immediate" | "this_week" | "this_month" | "nurture" | "never"): How quickly to follow up.
- keyQuote (string): The exact phrase from their reply that most clearly signals their intent. Under 15 words. Empty string if nothing stands out.
- isAutoReply (boolean): true if this appears to be an automated OOO or bounce reply.`,

    `Classify this B2B cold email reply:

---
${replyBody.slice(0, 3000)}
---

Be precise. Distinguish genuine interest from polite brush-offs, flag referrals, and catch auto-replies.`
  )
}
