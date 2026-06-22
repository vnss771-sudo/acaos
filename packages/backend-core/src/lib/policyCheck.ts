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
}

const DEFAULT_POLICY: Required<DraftPolicyConfig> = {
  minSubjectLength: 5,
  maxSubjectLength: 80,
  minBodyLength: 30,
  maxBodyLength: 3000,
  forbiddenPhrases: [],
  requireTemplate: false,
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

  // Check for unsubscribe link (RFC 2369 compliance)
  if (!body.includes('unsubscribe') && !body.includes('List-Unsubscribe')) {
    violations.push({
      code: 'MISSING_UNSUBSCRIBE',
      message: 'Email body must include an unsubscribe link or notice'
    })
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
