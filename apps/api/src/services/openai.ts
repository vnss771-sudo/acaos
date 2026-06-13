import OpenAI from 'openai'
import { ApiError } from '../lib/http.js'
import { hasEnv } from '../lib/env.js'
import { openAiBreaker, CircuitOpenError } from '../lib/circuit.js'

function getOpenAiClient() {
  if (!hasEnv(['OPENAI_API_KEY'])) throw new ApiError(503, 'OpenAI is not configured')
  // Bounded timeout + retries so a hung provider socket can't pin a worker slot
  // or HTTP request indefinitely.
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: Number(process.env.OPENAI_TIMEOUT_MS || 30_000),
    maxRetries: 2,
  })
}

function model() {
  return process.env.OPENAI_MODEL || 'gpt-4o-mini'
}

async function chat(system: string, user: string): Promise<string> {
  try {
    return await openAiBreaker.call(async () => {
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
    })
  } catch (err) {
    if (err instanceof CircuitOpenError) {
      throw new ApiError(503, 'AI service temporarily unavailable — try again shortly')
    }
    throw err
  }
}

export async function generateLeadResearch(input: {
  businessName: string
  website?: string
  category?: string
  city?: string
  notes?: string
}): Promise<string> {
  return chat(
    `You are an expert B2B sales intelligence analyst specialising in field-service businesses — civil engineering, electrical, plumbing, HVAC, landscaping, facilities management, roofing, painting, construction, and adjacent trades.

Your job: produce actionable sales intelligence for a cold outreach campaign selling field operations software (scheduling, dispatch, quoting, job costing, invoicing).

Return ONLY a valid JSON object with these exact keys:
- aiSummary (string): 2–3 sentences. Describe the business, its likely operational pain points, and why they are a strong or weak fit for field ops software. Be concrete: mention the type of field work they do, estimated team size signals, and the single biggest coordination headache they probably face.
- outreachAngle (string): The single strongest personalised hook for a cold email opener — under 20 words. Must reference something specific about their business, NOT a generic benefit. Good: "Managing job dispatch across 12 crews without a shared schedule". Bad: "We help you save time".
- qualificationSignals (string[]): 3–5 specific signals extracted from available info (e.g. "Field-based workforce, likely 10–50 field staff", "No FSM software visible on site or in job listings", "Active hiring suggests growth phase", "Multiple office locations imply coordination complexity").
- icpScore (number): 0–100. How closely this prospect matches the ideal field-service ICP: 50–400 employees, field-based ops, low digital maturity, growing. Deduct for: very small (<10 employees), enterprise with existing software, non-field industries.
- hiringSignals (boolean): true if any evidence suggests they are currently hiring or expanding headcount.
- digitalMaturity ("low" | "medium" | "high"): Infer from web presence, job listings, and mentions of tools. Low = spreadsheets/paper, Medium = generic software, High = dedicated FSM/ERP already in place.
- estimatedTeamSize ("1-10" | "10-50" | "50-200" | "200-500" | "500+"): Best estimate from all available signals.`,

    `Analyse this prospect for B2B cold outreach:

Business name: ${input.businessName}
Industry / category: ${input.category || 'Not specified'}
City / region: ${input.city || 'Not specified'}
Website: ${input.website || 'Not provided'}
Additional notes: ${input.notes || 'None'}

Key question to answer: Are they large enough to have real coordination problems but small enough that they haven't already solved them with enterprise software?`
  )
}

export async function generateOutreach(input: {
  businessName: string
  category?: string
  city?: string
  contactName?: string
  aiSummary?: string
  outreachAngle?: string
}): Promise<string> {
  const firstName = input.contactName?.split(' ')[0] ?? null

  return chat(
    `You are an elite B2B cold email copywriter. You write for a field operations software company targeting trades and field-service businesses.

Your emails achieve 15–30% reply rates because they:
1. Reference something specific about the recipient's actual business — not generic platitudes
2. Stay under 90 words in the body (brevity is respect)
3. Open with a crisp, relevant observation — never "I hope this email finds you well"
4. Make ONE clear ask: a simple yes/no or a low-friction question (never "book a 30-min demo")
5. Sound like a thoughtful human, not a marketing department

Return ONLY a valid JSON object with these exact keys:
- subject (string): Under 8 words. No "Intro:", no emoji. Feels like an internal forward, not a campaign email. Example: "field scheduling for ${input.businessName || 'your team'}".
- email (string): The full email body. No subject line, no sign-off — body only. Under 90 words. Personalised opener referencing their specific business. One clear question CTA at the end.
- followup (string): A 2-sentence follow-up for 4–5 days later if no reply. Acknowledge the first email, offer a slightly different angle or value point. Still ends with a question.`,

    `Write a cold outreach email for this prospect:

Business: ${input.businessName}
Industry: ${input.category || 'field services'}
Location: ${input.city || 'their area'}
${firstName ? `Contact first name: ${firstName}` : ''}
Research summary: ${input.aiSummary || 'Growing field service company needing better coordination tools'}
Best hook: ${input.outreachAngle || 'streamlining field team coordination as they scale'}

Make the email feel like it was written specifically for ${input.businessName}, not from a template.`
  )
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
