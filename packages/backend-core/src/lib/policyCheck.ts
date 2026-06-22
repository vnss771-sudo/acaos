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
}

const DEFAULT_POLICY: Required<DraftPolicyConfig> = {
  minSubjectLength: 5,
  maxSubjectLength: 80,
  minBodyLength: 30,
  maxBodyLength: 3000,
  forbiddenPhrases: [],
  requireTemplate: false,
  requireUnsubscribeInBody: false,
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
