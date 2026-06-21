// Client-side compliance/risk linter for outreach drafts. The unicorn packs
// asked for "risk flags visible before approve" on the Review Queue. The draft
// payload carries no risk metadata, so this derives flags purely from the draft
// text — no backend change. It is advisory (it never blocks approval); it just
// makes deliverability/compliance risks visible to the reviewer.

export type RiskLevel = 'warn' | 'caution'

export type DraftRisk = {
  id: string
  level: RiskLevel
  message: string
}

const SPAM_PHRASES = [
  'act now', 'limited time', 'risk-free', 'risk free', '100% free', 'cash bonus',
  'click here', 'buy now', 'guarantee', 'free money', 'no obligation',
]

// `warn` = likely a mistake that should be fixed before sending (placeholders,
// missing subject). `caution` = deliverability/compliance smell worth a look.
export function analyzeDraft(subject: string, body: string): DraftRisk[] {
  const risks: DraftRisk[] = []
  const subj = (subject ?? '').trim()
  const text = (body ?? '').trim()
  const haystack = `${subj}\n${text}`

  if (!subj) {
    risks.push({ id: 'no-subject', level: 'warn', message: 'Missing subject line.' })
  }

  // Unresolved merge tokens like {{firstName}} or [Company].
  if (/\{\{.*?\}\}|\[[A-Za-z][\w .-]*\]/.test(haystack)) {
    risks.push({ id: 'placeholder', level: 'warn', message: 'Unresolved placeholder — fill it in before sending.' })
  }

  if (!text || text.length < 20) {
    risks.push({ id: 'too-short', level: 'warn', message: 'Body is very short — it may read as low effort.' })
  } else if (text.length > 2000) {
    risks.push({ id: 'too-long', level: 'caution', message: 'Body is long — shorter cold outreach tends to convert better.' })
  }

  if (!/unsubscribe|opt[\s-]?out|reply\s+stop/i.test(haystack)) {
    risks.push({ id: 'no-optout', level: 'caution', message: 'No opt-out language — recommended for compliant outreach.' })
  }

  const hit = SPAM_PHRASES.find(p => haystack.toLowerCase().includes(p))
  if (hit) {
    risks.push({ id: 'spam-words', level: 'caution', message: `Spam-trigger phrasing ("${hit}") can hurt deliverability.` })
  }

  if (subj && subj.length > 2 && subj === subj.toUpperCase() && /[A-Z]/.test(subj)) {
    risks.push({ id: 'caps-subject', level: 'caution', message: 'Subject is all caps — looks like spam.' })
  }

  if ((haystack.match(/!/g) ?? []).length >= 3) {
    risks.push({ id: 'exclamations', level: 'caution', message: 'Excessive exclamation marks.' })
  }

  return risks
}
