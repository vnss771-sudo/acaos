// Sensitive-data scan for outbound mail. An email ACAOS sends on a workspace's
// behalf must never carry a payment card number, a secret API/private key, a
// password, or a tax file number — whether an AI draft picked it up from
// business context or lead notes, or a person pasted it while editing. A
// finding routes an AI draft to POLICY_REVIEW, blocks approval, and stops the
// send; the same patterns also redact stored excerpts of inbound mail.
//
// Deterministic and dependency-free. Each rule wants hard evidence (a valid
// card prefix plus the Luhn checksum, a provider's fixed key prefix, a TFN
// checksum next to the words "TFN"/"tax file number") so ordinary contractor
// email — invoice and job numbers, phone numbers, ABNs, BSB and account
// details for payment — doesn't trip it.

export const SENSITIVE_KINDS = ['PAYMENT_CARD', 'SECRET_KEY', 'PASSWORD', 'TAX_FILE_NUMBER'] as const
export type SensitiveKind = (typeof SENSITIVE_KINDS)[number]

export const SENSITIVE_LABEL: Record<SensitiveKind, string> = {
  PAYMENT_CARD: 'a payment card number',
  SECRET_KEY: 'a secret API or private key',
  PASSWORD: 'a password',
  TAX_FILE_NUMBER: 'a tax file number',
}

type Rule = { kind: SensitiveKind; re: RegExp; valid?: (match: string) => boolean }

const CARD_CANDIDATE = /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g

function digitsOf(s: string): string {
  return s.replace(/\D/g, '')
}

function luhnValid(digits: string): boolean {
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9 }
    sum += d
  }
  return sum % 10 === 0
}

// Issuer prefixes for the major networks: Visa, Mastercard, Amex, Discover,
// JCB, Diners. Luhn alone passes one random number in ten; requiring a real
// issuer prefix and length keeps tracking and reference numbers out.
function looksLikeCard(match: string): boolean {
  const d = digitsOf(match)
  if (d.length < 13 || d.length > 19 || !luhnValid(d)) return false
  const two = Number(d.slice(0, 2))
  const four = Number(d.slice(0, 4))
  if (d[0] === '4') return [13, 16, 19].includes(d.length)
  if ((two >= 51 && two <= 55) || (four >= 2221 && four <= 2720)) return d.length === 16
  if (two === 34 || two === 37) return d.length === 15
  if (d.startsWith('6011') || two === 65 || (four >= 6440 && four <= 6499)) return d.length >= 16
  if (four >= 3528 && four <= 3589) return d.length >= 16
  if (two === 36 || two === 38 || (Number(d.slice(0, 3)) >= 300 && Number(d.slice(0, 3)) <= 305)) return d.length >= 14
  return false
}

// TFN check digits (ATO): weights 1,4,3,7,5,8,6,9,10, sum divisible by 11.
function tfnValid(match: string): boolean {
  const d = digitsOf(match.replace(/^.*?(?=\d)/s, ''))
  if (d.length !== 9) return false
  const w = [1, 4, 3, 7, 5, 8, 6, 9, 10]
  return w.reduce((s, wi, i) => s + wi * Number(d[i]), 0) % 11 === 0
}

const RULES: Rule[] = [
  { kind: 'PAYMENT_CARD', re: CARD_CANDIDATE, valid: looksLikeCard },
  // Fixed provider prefixes only: AWS access key, Stripe secret/restricted,
  // GitHub, Slack, Google API, Anthropic and OpenAI keys, PEM private keys.
  { kind: 'SECRET_KEY', re: /\b(?:AKIA[0-9A-Z]{16}|(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}|gh[pousr]_[0-9A-Za-z]{30,}|github_pat_[0-9A-Za-z_]{40,}|xox[abprs]-[0-9A-Za-z-]{10,}|AIza[0-9A-Za-z_-]{35}|sk-ant-[0-9A-Za-z_-]{20,}|sk-(?:proj-)?[0-9A-Za-z_-]{32,})/g },
  { kind: 'SECRET_KEY', re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g },
  // "password: x" / "password = x", or "password is x" when x looks like a
  // secret (has a digit or symbol) — not "the password is the same as before".
  { kind: 'PASSWORD', re: /\b(?:password|passwd|passcode|pwd)\s*[:=]\s*\S{3,}|\b(?:password|passcode)\s+is\s+(?=\S*[\d!@#$%^&*])\S{4,}/gi },
  // A 9-digit TFN (spaces allowed) within a few words of "TFN"/"tax file number".
  { kind: 'TAX_FILE_NUMBER', re: /\b(?:tfn|tax file (?:number|no\.?))\b[^\d\n]{0,20}\d{3}[ -]?\d{3}[ -]?\d{3}(?!\d)/gi, valid: tfnValid },
]

export type SensitiveFinding = { kind: SensitiveKind; start: number; end: number }

/** Every sensitive value in `text`, in order. Pure. */
export function scanSensitiveData(text: string | null | undefined): SensitiveFinding[] {
  const t = text ?? ''
  if (!t) return []
  const out: SensitiveFinding[] = []
  for (const rule of RULES) {
    rule.re.lastIndex = 0
    for (const m of t.matchAll(rule.re)) {
      if (rule.valid && !rule.valid(m[0])) continue
      out.push({ kind: rule.kind, start: m.index!, end: m.index! + m[0].length })
    }
  }
  return out.sort((a, b) => a.start - b.start)
}

/** The distinct kinds found, for messages and violation records. */
export function sensitiveKinds(text: string | null | undefined): SensitiveKind[] {
  return [...new Set(scanSensitiveData(text).map(f => f.kind))]
}

/** "a payment card number and a password" — for user-facing messages. */
export function describeSensitiveKinds(kinds: readonly SensitiveKind[]): string {
  const labels = kinds.map(k => SENSITIVE_LABEL[k])
  return labels.length <= 1 ? (labels[0] ?? '') : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
}

/** `text` with every finding replaced by a placeholder naming what was removed. */
export function redactSensitiveData(text: string): string {
  const findings = scanSensitiveData(text)
  let out = ''
  let pos = 0
  for (const f of findings) {
    if (f.start < pos) continue // overlapping finding already redacted
    out += text.slice(pos, f.start) + `[${SENSITIVE_LABEL[f.kind].replace(/^an? /, '')} removed]`
    pos = f.end
  }
  return out + text.slice(pos)
}
