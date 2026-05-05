import OpenAI from 'openai'
import { ApiError } from '../lib/http.js'
import { hasEnv } from '../lib/env.js'

function getOpenAiClient() {
  if (!hasEnv(['OPENAI_API_KEY'])) {
    throw new ApiError(503, 'OpenAI is not configured')
  }
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
}

function model() {
  return process.env.OPENAI_MODEL || 'gpt-4o-mini'
}

async function chat(system: string, user: string): Promise<string> {
  const client = getOpenAiClient()
  const completion = await client.chat.completions.create({
    model: model(),
    response_format: { type: 'json_object' },
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
  notes?: string
}): Promise<string> {
  return chat(
    'You are a B2B client acquisition research assistant. Return concise JSON only.',
    `Research this business for outbound prospecting:
Business: ${input.businessName}
Website: ${input.website || 'N/A'}
Notes: ${input.notes || 'N/A'}
Return JSON with keys: aiSummary (string), outreachAngle (string), qualificationSignals (string[]).`
  )
}

export async function generateOutreach(input: {
  businessName: string
  category?: string
  aiSummary?: string
  outreachAngle?: string
}): Promise<string> {
  return chat(
    'You write short, strong B2B cold outreach copy. Return JSON only.',
    `Write outreach for ${input.businessName} in category ${input.category || 'unknown'}.
Summary: ${input.aiSummary || 'N/A'}
Angle: ${input.outreachAngle || 'N/A'}
Return JSON with keys: subject (string), email (string), followup (string).`
  )
}

export async function analyzeReply(replyBody: string): Promise<string> {
  return chat(
    'You classify B2B cold email replies for sales teams. Return JSON only.',
    `Classify this reply and suggest the next action:
${replyBody}
Return JSON with keys: classification (INTERESTED|NOT_INTERESTED|NEEDS_MORE_INFO|OUT_OF_OFFICE|OTHER), summary (string), suggestedAction (string).`
  )
}
