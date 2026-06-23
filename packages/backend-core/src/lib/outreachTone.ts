// Tone guardrail for generated cold outreach. The strict draft schema guarantees
// a draft HAS a subject/email; this guards what the draft SAYS. The failure mode
// it prevents is the "creepy and unsupported" opener — copy that asserts private
// knowledge of the recipient's internal problems as fact ("I noticed you're
// struggling with dispatch"). Such claims must be reframed as a question; they
// are BLOCKED so the strict path regenerates rather than persisting them.
import { ApiError } from './errors.js'

export type ToneViolation = {
  kind: 'presumptuous_claim' | 'banned_phrase'
  severity: 'block' | 'warn'
  match: string
}

// High-precision patterns: the sender CLAIMING to know the recipient is
// struggling / behind / overwhelmed, etc. Deliberately narrow (an explicit
// "I noticed/know… you're struggling" shape) to avoid flagging legitimate
// question-framed copy like "how are you handling scheduling as you grow?".
const PRESUMPTUOUS_PATTERNS: RegExp[] = [
  /\bI\s+(?:noticed|saw|see|can\s+see|know|can\s+tell|understand|realiz\w*|recogniz\w*)\s+(?:that\s+)?(?:you(?:'re|\s+are|\s+guys|r\s+team)?|your\s+(?:team|business|company|crew|shop|firm))\b[^.?!]*\b(?:struggl\w*|having\s+(?:trouble|issues|a\s+hard\s+time)|dealing\s+with|overwhelmed|drowning|falling\s+behind|behind\s+on|losing|missing|wasting|bleeding|disorganiz\w*|in\s+chaos|a\s+mess)\b/i,
  /\byou(?:'re|\s+are)\s+(?:clearly|obviously|definitely|probably|likely|no\s+doubt)\s+(?:struggl\w*|deal\w*|overwhelm\w*|los\w*|miss\w*|wast\w*|behind)\b/i,
  /\byour\s+(?:team|business|company|crew)\s+is\s+(?:clearly|obviously|definitely|no\s+doubt)\b/i,
]

// Vague corporate filler the prompt already bans. WARN-only: a stray match isn't
// worth burning a regeneration/refund, but it's surfaced so quality can be tracked.
const BANNED_PHRASES = [
  'streamline', 'synergy', 'leverage', 'optimize', 'optimise', 'circle back',
  'low-hanging fruit', 'move the needle', 'drive growth', 'best-in-class',
  'cutting-edge', 'paradigm', 'revolutionize', 'revolutionise', 'game-changer',
]

/** Scan draft text for tone violations (both block- and warn-severity). Pure. */
export function assessOutreachTone(text: string): ToneViolation[] {
  const violations: ToneViolation[] = []
  for (const re of PRESUMPTUOUS_PATTERNS) {
    const m = re.exec(text)
    if (m) violations.push({ kind: 'presumptuous_claim', severity: 'block', match: m[0].slice(0, 140).trim() })
  }
  const lower = text.toLowerCase()
  for (const phrase of BANNED_PHRASES) {
    if (lower.includes(phrase)) violations.push({ kind: 'banned_phrase', severity: 'warn', match: phrase })
  }
  return violations
}

// Typed, fail-closed error for a draft whose tone is unusable. Extends ApiError
// so it maps to a 502 (like AiSchemaError) and is distinguishable in logs/metrics.
export class OutreachToneError extends ApiError {
  readonly violations: ToneViolation[]
  constructor(violations: ToneViolation[]) {
    super(502, `OUTREACH_TONE_VIOLATION: ${violations.map((v) => `${v.kind}="${v.match}"`).join('; ')}`)
    this.name = 'OutreachToneError'
    this.violations = violations
  }
}

/**
 * Inspect a generated draft. Throws OutreachToneError on any BLOCK-severity
 * violation (presumptuous claims) so the strict path fails closed and regenerates.
 * Returns the non-blocking warnings (buzzwords) for the caller to log.
 */
export function assertOutreachTone(draft: { subject?: string | null; email: string; followup?: string | null }): ToneViolation[] {
  const text = [draft.subject ?? '', draft.email, draft.followup ?? ''].join('\n')
  const violations = assessOutreachTone(text)
  const blocking = violations.filter((v) => v.severity === 'block')
  if (blocking.length > 0) throw new OutreachToneError(blocking)
  return violations.filter((v) => v.severity === 'warn')
}
