// Deterministic risk escalation for inbound mail. Runs before (and regardless
// of) any AI step: an email that mentions legal action, a refund or payment
// dispute, a formal complaint, damage the business is blamed for, or a data
// breach must reach a person — never be auto-classified into an irreversible
// lead stage (NOT_INTERESTED -> DEAD), fed to the scoring model, or answered
// with an AI draft.
//
// The phrases are deliberately narrow. Contractors' ordinary work vocabulary
// overlaps the obvious words — "security camera install", "tennis court
// resurface", "water damage repair", "Hi, Sue here" — so each rule needs an
// unambiguous phrase, not a single loose keyword. A missed escalation falls
// back to today's behaviour (the AI label); a false one only asks a human to
// look, so ambiguity resolves toward NOT flagging ordinary job talk.
//
// Pure and dependency-free so the reply path, the enquiry path and tests share it.

export const RISK_FLAGS = ['LEGAL', 'PAYMENT_DISPUTE', 'COMPLAINT', 'DAMAGE_CLAIM', 'DATA_BREACH'] as const
export type RiskFlag = (typeof RISK_FLAGS)[number]

const RULES: Record<RiskFlag, RegExp[]> = {
  LEGAL: [
    /\b(lawyers?|solicitors?|attorneys?|barristers?)\b/,
    /\b(lawsuit|legal action|legal proceedings|letter of demand|cease and desist|statutory demand)\b/,
    /\b(take|taking|see) (you|this|them|it) to (court|tribunal)\b/,
    /\b(small claims|court action|in court)\b/,
    /\b(ncat|vcat|qcat|acat|ntcat|tascat)\b/,
    /\b(will|going to|gonna|intend to|plan to) sue\b|\bsue (you|your)\b/,
  ],
  PAYMENT_DISPUTE: [
    /\b(refund|money back|chargeback|charge back)\b/,
    /\b(charged|billed) (me |us )?twice\b|\bdouble[- ](charged|billed)\b|\bovercharged\b/,
    /\b(dispute|disputing) (the|this|your|that) (invoice|bill|charge|payment|amount)\b/,
    /\b(not|won'?t|will not|refuse to) (be )?pay(ing)? (the|this|your|that)? ?(invoice|bill)\b/,
  ],
  COMPLAINT: [
    /\b(formal complaint|lodge a complaint|make a complaint|file a complaint)\b/,
    /\b(report|reporting) you\b/,
    /\b(fair trading|consumer affairs|accc|ombudsman|building commission|qbcc|vba)\b/,
    /\b(disgusted|appalled|appalling|furious|unacceptable|disgraceful)\b/,
  ],
  DAMAGE_CLAIM: [
    /\byou(r)? (guys? |team |crew |workers? |worker |tradies? |plumbers? |electricians? |staff )?(caused|damaged|broke|flooded|cracked|scratched)\b/,
    /\b(caused|left) (\w+ ){0,4}damage\b/,
    /\b(injured|injury|got (a )?shock|electric shock)\b/,
  ],
  DATA_BREACH: [
    /\b(data breach|data leak|privacy breach|been hacked|got hacked|was hacked|account (was )?compromised)\b/,
  ],
}

export type RiskAssessment = { flags: RiskFlag[]; escalate: boolean }

/**
 * Risk flags raised by `text` (subject + fresh reply body, quoted history
 * already stripped so our own outreach copy can't trigger them). Any flag means
 * escalate: a person decides, no automation acts.
 */
export function assessRisk(text: string | null | undefined): RiskAssessment {
  const t = (text ?? '').toLowerCase()
  if (!t.trim()) return { flags: [], escalate: false }
  const flags = RISK_FLAGS.filter(flag => RULES[flag].some(re => re.test(t)))
  return { flags, escalate: flags.length > 0 }
}

export const RISK_FLAG_LABEL: Record<RiskFlag, string> = {
  LEGAL: 'Mentions legal action',
  PAYMENT_DISPUTE: 'Refund or payment dispute',
  COMPLAINT: 'Complaint',
  DAMAGE_CLAIM: 'Says your work caused damage or injury',
  DATA_BREACH: 'Mentions a data breach',
}

/** Keep only recognised flags (DB/text column → typed). */
export function parseRiskFlags(values: readonly string[] | null | undefined): RiskFlag[] {
  return (values ?? []).filter((v): v is RiskFlag => (RISK_FLAGS as readonly string[]).includes(v))
}
