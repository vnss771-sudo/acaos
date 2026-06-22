/**
 * Draft content policy validation.
 * Enforces workspace-defined rules on AI-generated drafts before approval.
 */

export interface DraftPolicyViolation {
  code: string
  message: string
}

export interface DraftPolicyConfig {
  minSubjectLength?: number
  maxSubjectLength?: number
  minBodyLength?: number
  maxBodyLength?: number
  forbiddenPhrases?: string[]
  requireTemplate?: boolean
  // Opt-in: require the body itself to contain an unsubscribe notice. OFF by
  // default because ACAOS appends a compliant List-Unsubscribe footer to every
  // send (see worker send path) — turning this on would false-positive on the
  // raw draft body and block sends. Enable only for channels with no footer.
  requireUnsubscribeInBody?: boolean
  // Maximum number of links in the body. Excessive links are a strong spam signal
  // (link farms, tracking-pixel stuffing). The default is generous so normal
  // outreach (0–2 links) never trips it — and the compliant unsubscribe footer is
  // appended AFTER this check, so it isn't counted. 0 disables the rule.
  maxLinks?: number
}

const DEFAULT_POLICY: Required<DraftPolicyConfig> = {
  minSubjectLength: 5,
  maxSubjectLength: 80,
  minBodyLength: 30,
  maxBodyLength: 3000,
  forbiddenPhrases: [],
  requireTemplate: false,
  requireUnsubscribeInBody: false,
  maxLinks: 8,
}

/** Count http(s) links in a block of text. Pure; exported for testing. */
export function countLinks(text: string): number {
  const matches = text.match(/https?:\/\/[^\s<>"')\]]+/gi)
  return matches ? matches.length : 0
}

// Phrases that assert a PRIOR RELATIONSHIP / earlier contact. In cold outreach these
// are fabrications unless the lead genuinely has a recorded connection (notes). The
// generator is instructed never to invent one; this enforces that.
const PRIOR_CONTACT_RE =
  /\b(as (?:we|previously) discussed|as discussed|per our (?:conversation|call|chat|discussion)|following up on (?:our|my (?:last|previous))|after (?:we|our) (?:spoke|talked|chat|call|meeting)|great (?:to meet|meeting|to connect)(?: you| with you)|thanks for (?:your time|(?:the|our) (?:call|chat|meeting))|since we (?:last )?(?:spoke|talked|met|connected)|when we (?:spoke|met|talked)|good (?:talking|speaking|chatting) (?:to|with) you|enjoyed our (?:call|chat|conversation)|as a follow[- ]?up to our)\b/i

// Specific "congratulations on <event>" style claims. Each is only a violation when
// NONE of its grounding keywords appear in the prospect data we actually have — i.e.
// the draft invented a verifiable-sounding event we have no evidence for.
const EVENT_CLAIMS: Array<{ code: string; re: RegExp; grounding: string[] }> = [
  { code: 'FUNDING', re: /\b(?:your (?:recent )?(?:funding|raise|round)|congrat\w* on (?:the|your) (?:funding|raise|round|series)|series [a-e]\b|seed round|recently raised)\b/i, grounding: ['fund', 'raise', 'round', 'series ', 'seed', 'venture', 'investment'] },
  { code: 'ACQUISITION', re: /\b(?:your (?:recent )?acquisition|congrat\w* on the acquisition|after (?:you|your) acqui|recently acquired|your merger)\b/i, grounding: ['acqui', 'merg'] },
  { code: 'AWARD', re: /\b(?:congrat\w* on (?:the|your) award|your recent award|winning the|recently won)\b/i, grounding: ['award', 'recogni', 'won ', 'winner'] },
  { code: 'EXPANSION', re: /\b(?:your (?:new|recent) (?:office|location|branch)|congrat\w* on (?:the|your) (?:expansion|new (?:office|location))|recently (?:expanded|opened a))\b/i, grounding: ['expand', 'expansion', 'new location', 'new office', 'new branch', 'opened', 'growth', 'growing', 'scaling'] },
  { code: 'IPO', re: /\b(?:your ipo|going public|congrat\w* on (?:the|your) ipo)\b/i, grounding: ['ipo', 'public', 'listed'] },
]

/**
 * Flag fabricated factual claims about the prospect in a draft body — copy that
 * asserts a prior relationship, or congratulates the prospect on a specific event
 * (funding / acquisition / award / expansion / IPO) we have no grounding for. Pure
 * and deterministic. Conservative: an event claim is only flagged when none of its
 * grounding keywords appear in the prospect data, and prior-contact claims are
 * allowed when the lead has a recorded connection. Violations route to POLICY_REVIEW
 * (human gate) like any other — never an auto-send, never a silent drop.
 */
export function checkClaimGrounding(
  body: string,
  opts: { grounding?: string; hasPriorConnection?: boolean } = {}
): DraftPolicyViolation[] {
  const violations: DraftPolicyViolation[] = []
  const text = body || ''
  const grounding = (opts.grounding || '').toLowerCase()

  if (!opts.hasPriorConnection && PRIOR_CONTACT_RE.test(text)) {
    violations.push({
      code: 'FABRICATED_PRIOR_CONTACT',
      message: 'Email claims a prior conversation/relationship, but this is a cold contact with no recorded connection',
    })
  }

  for (const claim of EVENT_CLAIMS) {
    if (claim.re.test(text) && !claim.grounding.some((kw) => grounding.includes(kw))) {
      violations.push({
        code: 'UNSUPPORTED_CLAIM',
        message: `Email references a ${claim.code.toLowerCase()} event not supported by any known information about the prospect`,
      })
    }
  }

  return violations
}

export function checkDraftPolicy(
  draft: { subject: string; emailBody: string },
  policy?: DraftPolicyConfig
): DraftPolicyViolation[] {
  const finalPolicy = { ...DEFAULT_POLICY, ...policy }
  const violations: DraftPolicyViolation[] = []

  const subject = draft.subject.trim()
  const body = draft.emailBody.trim()

  // Subject length checks
  if (subject.length < finalPolicy.minSubjectLength) {
    violations.push({
      code: 'SUBJECT_TOO_SHORT',
      message: `Subject line is too short (min ${finalPolicy.minSubjectLength} characters)`
    })
  }
  if (subject.length > finalPolicy.maxSubjectLength) {
    violations.push({
      code: 'SUBJECT_TOO_LONG',
      message: `Subject line is too long (max ${finalPolicy.maxSubjectLength} characters)`
    })
  }

  // Body length checks
  if (body.length < finalPolicy.minBodyLength) {
    violations.push({
      code: 'BODY_TOO_SHORT',
      message: `Email body is too short (min ${finalPolicy.minBodyLength} characters)`
    })
  }
  if (body.length > finalPolicy.maxBodyLength) {
    violations.push({
      code: 'BODY_TOO_LONG',
      message: `Email body is too long (max ${finalPolicy.maxBodyLength} characters)`
    })
  }

  // Forbidden phrases check
  if (finalPolicy.forbiddenPhrases.length > 0) {
    const lowerBody = body.toLowerCase()
    for (const phrase of finalPolicy.forbiddenPhrases) {
      if (lowerBody.includes(phrase.toLowerCase())) {
        violations.push({
          code: 'FORBIDDEN_PHRASE',
          message: `Email contains prohibited phrase: "${phrase}"`
        })
      }
    }
  }

  // Check for unsubscribe notice — opt-in only. ACAOS guarantees a compliant
  // List-Unsubscribe footer on every send, so the raw draft body is not required
  // to carry one unless the workspace explicitly enables this.
  if (finalPolicy.requireUnsubscribeInBody) {
    const lowerForUnsub = body.toLowerCase()
    if (!lowerForUnsub.includes('unsubscribe') && !lowerForUnsub.includes('list-unsubscribe')) {
      violations.push({
        code: 'MISSING_UNSUBSCRIBE',
        message: 'Email body must include an unsubscribe link or notice'
      })
    }
  }

  // Too many links — a strong spam signal. Generous default; the unsubscribe
  // footer is appended after this check, so it isn't counted here.
  if (finalPolicy.maxLinks > 0) {
    const linkCount = countLinks(body)
    if (linkCount > finalPolicy.maxLinks) {
      violations.push({
        code: 'TOO_MANY_LINKS',
        message: `Email contains too many links (${linkCount}; max ${finalPolicy.maxLinks})`
      })
    }
  }

  // Check for false claims (simple patterns)
  const riskPatterns = [
    /\b(guaranteed|100% guaranteed)\b/i,
    /\b(unlimited|free|no cost)\b.*\b(money|cash|profit|income)\b/i,
    /\b(only [a-z]+ can)\b/i,  // "only you can" claims
  ]
  for (const pattern of riskPatterns) {
    if (pattern.test(body)) {
      violations.push({
        code: 'RISKY_LANGUAGE',
        message: 'Email contains language that may violate FTC guidelines (claims, guarantees, urgency)'
      })
      break  // Only report once
    }
  }

  // Check for business credibility info (if sender details are required)
  if (finalPolicy.requireTemplate) {
    const hasBasicCredibility = body.includes('website') || body.includes('linkedin') ||
                                body.includes('company') || body.includes('team')
    if (!hasBasicCredibility) {
      violations.push({
        code: 'MISSING_CREDIBILITY',
        message: 'Email should reference your website, LinkedIn, or company information'
      })
    }
  }

  return violations
}

export function formatViolations(violations: DraftPolicyViolation[]): string {
  if (violations.length === 0) return ''
  return violations.map(v => `${v.code}: ${v.message}`).join('\n')
}
